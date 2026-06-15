import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { publishIrrigationCommand } from "@/lib/mqtt";
import { createSupabaseAdmin } from "@/lib/supabase-server";

const MQTT_MAX_DURATION_SECONDS = 1800;

function normalizeCommandStatus(status: string) {
  const lower = status.toLowerCase();
  if (lower === "completed" || lower === "started" || lower === "progress" || lower === "forced_off") {
    return "acknowledged";
  }
  if (lower.includes("failed") || lower.includes("rejected")) return "failed";
  return "acknowledged";
}

function normalizeRecommendationStatus(status: string) {
  const lower = status.toLowerCase();
  if (lower === "completed") return "completed";
  if (lower.includes("failed") || lower.includes("rejected")) return "cancelled";
  return null;
}

function numberFrom(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function publishNextBatch(input: {
  supabase: ReturnType<typeof createSupabaseAdmin>;
  commandRow: {
    id: number;
    land_id: number;
    recommendation_id: number | null;
    payload: any;
  };
  deviceUid: string;
}) {
  const payload = input.commandRow.payload && typeof input.commandRow.payload === "object"
    ? input.commandRow.payload
    : {};
  const safety = payload.safety && typeof payload.safety === "object" ? payload.safety : {};
  const currentBatch = numberFrom(payload.batch?.current) ?? 1;
  const totalBatches = numberFrom(payload.batch?.total);
  const remainingDuration = Math.max(0, numberFrom(safety.remaining_duration_seconds) ?? 0);
  const remainingLiters = numberFrom(safety.remaining_liters_target);
  const flowRateLitersPerMinute = numberFrom(payload.flow_rate_liters_per_minute ?? safety.flow_rate_liters_per_minute);

  if (remainingDuration <= 0) return null;

  const nextDuration = Math.min(MQTT_MAX_DURATION_SECONDS, remainingDuration);
  const nextRemainingDuration = Math.max(0, remainingDuration - nextDuration);
  const nextLiters = remainingLiters === null
    ? null
    : Number((remainingLiters * (nextDuration / remainingDuration)).toFixed(4));
  const nextRemainingLiters = remainingLiters === null
    ? null
    : Math.max(0, Number((remainingLiters - Number(nextLiters ?? 0)).toFixed(4)));
  const nextCommandUuid = randomUUID();
  const nextBatchTotal = totalBatches ?? Math.ceil(
    (Number(safety.requested_duration_seconds ?? 0) || (remainingDuration + Number(payload.duration_seconds ?? 0))) / MQTT_MAX_DURATION_SECONDS
  );
  const mqttTopicCommand = `farms/${input.commandRow.land_id}/devices/${input.deviceUid}/commands`;

  const nextPayload = {
    command_id: nextCommandUuid,
    land_id: input.commandRow.land_id,
    device_uid: input.deviceUid,
    status: "ON" as const,
    duration_seconds: nextDuration,
    issued_at: new Date().toISOString(),
    reason: `Auto batch ${currentBatch + 1}/${nextBatchTotal} after command ${payload.command_id ?? input.commandRow.id}`,
    liters_target: nextLiters,
    flow_rate_liters_per_minute: flowRateLitersPerMinute,
    batch: {
      current: currentBatch + 1,
      total: nextBatchTotal
    },
    recommendation: payload.recommendation ?? null,
    safety: {
      max_duration_seconds: MQTT_MAX_DURATION_SECONDS,
      requested_duration_seconds: safety.requested_duration_seconds ?? remainingDuration,
      requested_liters_target: safety.requested_liters_target ?? remainingLiters,
      published_liters_target: nextLiters,
      flow_rate_liters_per_minute: flowRateLitersPerMinute,
      duration_was_split: nextRemainingDuration > 0,
      remaining_duration_seconds: nextRemainingDuration,
      remaining_liters_target: nextRemainingLiters,
      require_ack: true,
      manual_override: Boolean(safety.manual_override),
      chained_from_command_id: payload.command_id ?? null
    }
  };

  const mqttPayload = {
    command_id: nextPayload.command_id,
    land_id: nextPayload.land_id,
    device_uid: nextPayload.device_uid,
    status: nextPayload.status,
    duration_seconds: nextPayload.duration_seconds,
    issued_at: nextPayload.issued_at,
    reason: nextPayload.reason,
    liters_target: nextPayload.liters_target,
    flow_rate_liters_per_minute: nextPayload.flow_rate_liters_per_minute,
    batch: nextPayload.batch,
    recommendation: nextPayload.recommendation
      ? {
          id: nextPayload.recommendation.id,
          liters_per_day: nextPayload.recommendation.liters_per_day
        }
      : null,
    safety: {
      max_duration_seconds: MQTT_MAX_DURATION_SECONDS,
      require_ack: true,
      manual_override: nextPayload.safety.manual_override,
      duration_was_split: nextPayload.safety.duration_was_split
    }
  };

  const { data: deviceRow, error: deviceError } = await input.supabase
    .from("iot_devices")
    .select("id")
    .eq("land_id", input.commandRow.land_id)
    .eq("device_uid", input.deviceUid)
    .maybeSingle();

  if (deviceError) throw deviceError;
  if (!deviceRow) throw new Error("Cannot chain next irrigation batch: device row not found.");

  const { data: commandRow, error: insertError } = await input.supabase
    .from("iot_commands")
    .insert({
      land_id: input.commandRow.land_id,
      device_id: deviceRow.id,
      recommendation_id: input.commandRow.recommendation_id ?? null,
      command_uuid: nextCommandUuid,
      payload: nextPayload,
      status: "queued"
    })
    .select("id,command_uuid")
    .single();

  if (insertError) throw insertError;

  try {
    await publishIrrigationCommand(mqttTopicCommand, mqttPayload);
    await input.supabase
      .from("iot_commands")
      .update({
        status: "published",
        published_at: new Date().toISOString()
      })
      .eq("id", commandRow.id);

    return {
      commandId: commandRow.id,
      commandUuid: commandRow.command_uuid,
      topic: mqttTopicCommand,
      durationSeconds: nextDuration,
      litersTarget: nextLiters,
      batch: nextPayload.batch,
      remainingDurationSeconds: nextRemainingDuration,
      remainingLitersTarget: nextRemainingLiters
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "MQTT publish failed for next batch";
    await input.supabase
      .from("iot_commands")
      .update({
        status: "failed",
        ack_payload: {
          error: message,
          failed_at: new Date().toISOString(),
          chained_from_command_id: payload.command_id ?? null
        }
      })
      .eq("id", commandRow.id);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const commandId = String(body.command_id ?? "").trim();
  const deviceUid = String(body.device_uid ?? "").trim();
  const status = String(body.status ?? "").trim();
  const landId = Number(body.land_id);

  if (!commandId || !deviceUid || !status) {
    return NextResponse.json(
      { error: "command_id, device_uid, and status are required" },
      { status: 400 }
    );
  }

  const supabase = createSupabaseAdmin();
  const now = new Date().toISOString();

  if (commandId === "boot" || status.toLowerCase() === "online" || status.toLowerCase() === "heartbeat") {
    if (Number.isFinite(landId) && landId > 0) {
      const mqttTopicCommand = `farms/${landId}/devices/${deviceUid}/commands`;
      const mqttTopicAck = `farms/${landId}/devices/${deviceUid}/ack`;
      const { data: existingDevice, error: existingDeviceError } = await supabase
        .from("iot_devices")
        .select("id")
        .eq("device_uid", deviceUid)
        .maybeSingle();

      if (existingDeviceError) {
        return NextResponse.json({ error: existingDeviceError.message }, { status: 500 });
      }

      const deviceResult = existingDevice
        ? await supabase
            .from("iot_devices")
            .update({ is_active: true, last_seen_at: now })
            .eq("id", existingDevice.id)
        : await supabase
            .from("iot_devices")
            .insert({
              land_id: landId,
              device_uid: deviceUid,
              mqtt_topic_command: mqttTopicCommand,
              mqtt_topic_ack: mqttTopicAck,
              is_active: true,
              last_seen_at: now
            });

      const deviceError = deviceResult.error;

      if (deviceError) {
        return NextResponse.json({ error: deviceError.message }, { status: 500 });
      }
    } else {
      await supabase
        .from("iot_devices")
        .update({ last_seen_at: now, is_active: true })
        .eq("device_uid", deviceUid);
    }

    return NextResponse.json({
      status: "device_online",
      device_uid: deviceUid,
      seenAt: now
    });
  }

  const { data: commandRow, error: commandError } = await supabase
    .from("iot_commands")
    .select("id,land_id,recommendation_id,command_uuid,payload,status,ack_payload")
    .eq("command_uuid", commandId)
    .maybeSingle();

  if (commandError) {
    return NextResponse.json({ error: commandError.message }, { status: 500 });
  }

  if (!commandRow) {
    return NextResponse.json({ error: "command_id was not found" }, { status: 404 });
  }

  const expectedDeviceUid = (commandRow.payload as { device_uid?: string } | null)?.device_uid;
  if (expectedDeviceUid && expectedDeviceUid !== deviceUid) {
    return NextResponse.json(
      { error: "device_uid does not match the command payload" },
      { status: 409 }
    );
  }

  const commandStatus = normalizeCommandStatus(status);
  const ackStatus = status.toLowerCase();
  const existingAckPayload = commandRow.ack_payload && typeof commandRow.ack_payload === "object"
    ? commandRow.ack_payload as Record<string, unknown>
    : {};
  const existingHistory = Array.isArray(existingAckPayload.ack_history)
    ? existingAckPayload.ack_history
    : [];
  const ackEntry = {
    ...body,
    received_at: now
  };
  let nextBatch: Awaited<ReturnType<typeof publishNextBatch>> = null;
  let nextBatchError: string | null = null;
  if (ackStatus === "completed" && existingAckPayload.next_batch) {
    nextBatch = existingAckPayload.next_batch as Awaited<ReturnType<typeof publishNextBatch>>;
  } else if (ackStatus === "completed") {
    try {
      nextBatch = await publishNextBatch({
        supabase,
        commandRow: {
          id: commandRow.id,
          land_id: commandRow.land_id,
          recommendation_id: commandRow.recommendation_id,
          payload: commandRow.payload
        },
        deviceUid
      });
    } catch (error) {
      nextBatchError = error instanceof Error ? error.message : "Failed to publish next irrigation batch";
    }
  }

  const { error: updateError } = await supabase
    .from("iot_commands")
    .update({
      status: commandStatus,
      acknowledged_at: now,
      ack_payload: {
        ...ackEntry,
        first_ack_at: existingAckPayload.first_ack_at ?? now,
        next_batch: nextBatch,
        next_batch_error: nextBatchError,
        ack_history: [...existingHistory.slice(-14), ackEntry]
      }
    })
    .eq("id", commandRow.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const hasRemainingBatches = Boolean(nextBatch || nextBatchError);
  const recommendationStatus = commandRow.recommendation_id && !hasRemainingBatches
    ? normalizeRecommendationStatus(status)
    : null;

  if (recommendationStatus) {
    await supabase
      .from("irrigation_recommendations")
      .update({ status: recommendationStatus })
      .eq("id", commandRow.recommendation_id);
  }

  await supabase
    .from("iot_devices")
    .update({ last_seen_at: now, is_active: true })
    .eq("device_uid", deviceUid);

  return NextResponse.json({
    commandId: commandRow.id,
    commandUuid: commandRow.command_uuid,
    commandStatus,
    recommendationStatus,
    acknowledgedAt: now,
    nextBatch,
    nextBatchError
  });
}
