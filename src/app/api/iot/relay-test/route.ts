import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { publishIrrigationCommand } from "@/lib/mqtt";
import { createSupabaseAdmin } from "@/lib/supabase-server";

function uniqueTopics(topics: Array<string | null | undefined>) {
  return [...new Set(topics.filter((topic): topic is string => Boolean(topic)))];
}

function inferLegacyLandIdFromDeviceUid(deviceUid: string) {
  const match = deviceUid.match(/(?:^|-)land-(\d+)(?:-|$)/i);
  const landId = match ? Number(match[1]) : NaN;
  return Number.isFinite(landId) && landId > 0 ? landId : null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCommandAck(input: {
  supabase: ReturnType<typeof createSupabaseAdmin>;
  commandUuid: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < input.timeoutMs) {
    const { data } = await input.supabase
      .from("iot_commands")
      .select("id,status,ack_payload,acknowledged_at")
      .eq("command_uuid", input.commandUuid)
      .maybeSingle();

    if (data?.ack_payload || data?.acknowledged_at || data?.status === "acknowledged") {
      return {
        received: true,
        status: data.status,
        acknowledgedAt: data.acknowledged_at,
        payload: data.ack_payload
      };
    }

    await delay(500);
  }

  return {
    received: false,
    status: "timeout",
    acknowledgedAt: null,
    payload: null
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const landId = Number(body.land_id ?? 2);
  const deviceUid = String(body.device_uid ?? "esp32-land-2-demo-valve").trim();
  const durationSeconds = Math.max(1, Math.min(10, Number(body.duration_seconds ?? 5)));

  if (!Number.isFinite(landId) || landId <= 0 || !deviceUid) {
    return NextResponse.json({ error: "land_id and device_uid are required" }, { status: 400 });
  }

  const supabase = createSupabaseAdmin();
  const mqttTopicCommand = `farms/${landId}/devices/${deviceUid}/commands`;
  const mqttTopicAck = `farms/${landId}/devices/${deviceUid}/ack`;
  const now = new Date().toISOString();

  const { data: existingDevice, error: existingDeviceError } = await supabase
    .from("iot_devices")
    .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack")
    .eq("device_uid", deviceUid)
    .maybeSingle();

  if (existingDeviceError) {
    return NextResponse.json({ error: existingDeviceError.message }, { status: 500 });
  }

  const deviceResult = existingDevice
    ? await supabase
        .from("iot_devices")
        .update({
          land_id: landId,
          is_active: true,
          last_seen_at: now
        })
        .eq("id", existingDevice.id)
        .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack")
        .single()
    : await supabase
        .from("iot_devices")
        .insert({
          land_id: landId,
          device_uid: deviceUid,
          mqtt_topic_command: mqttTopicCommand,
          mqtt_topic_ack: mqttTopicAck,
          is_active: true,
          last_seen_at: now
        })
        .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack")
        .single();

  const { data: deviceRow, error: deviceError } = deviceResult;

  if (deviceError) {
    return NextResponse.json({ error: deviceError.message }, { status: 500 });
  }

  const { data: latestTelemetry } = await supabase
    .from("iot_telemetry")
    .select("land_id")
    .eq("device_uid", deviceUid)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const legacyLandId = inferLegacyLandIdFromDeviceUid(deviceUid);
  const publishTopics = uniqueTopics([
    deviceRow.mqtt_topic_command,
    existingDevice?.mqtt_topic_command,
    mqttTopicCommand,
    latestTelemetry?.land_id ? `farms/${latestTelemetry.land_id}/devices/${deviceUid}/commands` : null,
    legacyLandId ? `farms/${legacyLandId}/devices/${deviceUid}/commands` : null
  ]);

  const commandUuid = randomUUID();
  const payload = {
    command_id: commandUuid,
    land_id: landId,
    device_uid: deviceUid,
    status: "ON" as const,
    duration_seconds: durationSeconds,
    issued_at: now,
    reason: "Hardware relay diagnostic test. Not an irrigation decision.",
    liters_target: 0,
    diagnostic: true,
    safety: {
      max_duration_seconds: 10,
      require_ack: true,
      diagnostic_test: true
    }
  };

  const { data: commandRow, error: commandError } = await supabase
    .from("iot_commands")
    .insert({
      land_id: landId,
      device_id: deviceRow.id,
      recommendation_id: null,
      command_uuid: commandUuid,
      payload,
      status: "queued"
    })
    .select("id,command_uuid")
    .single();

  if (commandError) {
    return NextResponse.json({ error: commandError.message }, { status: 500 });
  }

  try {
    await Promise.all(publishTopics.map((topic) => publishIrrigationCommand(topic, payload)));

    await supabase
      .from("iot_commands")
      .update({
        status: "published",
        published_at: now
      })
      .eq("id", commandRow.id);

    const ack = await waitForCommandAck({
      supabase,
      commandUuid: commandRow.command_uuid,
      timeoutMs: 10_000
    });

    return NextResponse.json({
      commandId: commandRow.id,
      commandUuid: commandRow.command_uuid,
      topic: deviceRow.mqtt_topic_command ?? mqttTopicCommand,
      topics: publishTopics,
      payload,
      status: ack.received ? "acknowledged" : "published_waiting_ack",
      ack
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MQTT relay test publish failed";
    await supabase
      .from("iot_commands")
      .update({
        status: "failed",
        ack_payload: {
          error: message,
          failed_at: new Date().toISOString(),
          diagnostic: true
        }
      })
      .eq("id", commandRow.id);

    return NextResponse.json(
      {
        error: message,
        commandId: commandRow.id,
        commandUuid: commandRow.command_uuid,
        topic: mqttTopicCommand,
        status: "failed"
      },
      { status: 500 }
    );
  }
}
