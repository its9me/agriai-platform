import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { reviewIrrigationCommandSafety } from "@/lib/gemini";
import { publishIrrigationCommand } from "@/lib/mqtt";
import { buildPottedCommandPreview } from "@/lib/potted-plants";
import { createSupabaseAdmin } from "@/lib/supabase-server";

const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const MQTT_MAX_DURATION_SECONDS = 1800;
const REQUEST_MAX_DURATION_SECONDS = 24 * 60 * 60;

function uniqueTopics(topics: Array<string | null | undefined>) {
  return [...new Set(topics.filter((topic): topic is string => Boolean(topic)))];
}

function inferLegacyLandIdFromDeviceUid(deviceUid: string) {
  const match = deviceUid.match(/(?:^|-)land-(\d+)(?:-|$)/i);
  const landId = match ? Number(match[1]) : NaN;
  return Number.isFinite(landId) && landId > 0 ? landId : null;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const landId = Number(body.land_id);
  const deviceUid = String(body.device_uid ?? "");
  const recommendationId = Number(body.recommendation_id);
  let durationSeconds = Number(body.duration_seconds);
  let litersTarget = Number(body.liters_target);
  let flowRateLitersPerMinute = Number(body.flow_rate_liters_per_minute ?? body.flowRateLitersPerMinute);
  const batch = Number(body.batch);
  const batchTotal = Number(body.batch_total);
  const manualOverride = body.manual_override === true;
  const sensorAutopilot = body.sensor_autopilot === true;
  const requestedStatus = String(body.status ?? "ON").toUpperCase();
  const isStopCommand = requestedStatus === "OFF";
  const commandStatus: "ON" | "OFF" = isStopCommand ? "OFF" : "ON";
  const maxDurationSeconds = MQTT_MAX_DURATION_SECONDS;
  const commandReason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : null;

  if (!Number.isFinite(landId) || !deviceUid) {
    return NextResponse.json(
      { error: "land_id and device_uid are required" },
      { status: 400 }
    );
  }

  if (requestedStatus !== "ON" && requestedStatus !== "OFF") {
    return NextResponse.json(
      { error: "status must be ON or OFF" },
      { status: 400 }
    );
  }

  const supabase = createSupabaseAdmin();
  let recommendationRow: {
    id: number;
    recommended_duration_seconds: number;
    total_liters_per_day: number;
    flow_rate_liters_per_minute?: number | null;
    status: string;
  } | null = null;

  if (!isStopCommand && Number.isFinite(recommendationId) && recommendationId > 0) {
    const { data, error } = await supabase
      .from("irrigation_recommendations")
      .select("id,recommended_duration_seconds,total_liters_per_day,flow_rate_liters_per_minute,status")
      .eq("id", recommendationId)
      .eq("land_id", landId)
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    recommendationRow = data;
    if (!Number.isFinite(durationSeconds)) {
      durationSeconds = Number(data.recommended_duration_seconds);
    }
  } else if (!isStopCommand) {
    const { data, error } = await supabase
      .from("irrigation_recommendations")
      .select("id,recommended_duration_seconds,total_liters_per_day,flow_rate_liters_per_minute,status")
      .eq("land_id", landId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    recommendationRow = data ?? null;
  }

  if (isStopCommand) {
    durationSeconds = 0;
    litersTarget = 0;
    flowRateLitersPerMinute = 0;
  }

  if ((!Number.isFinite(litersTarget) || litersTarget <= 0) && recommendationRow?.total_liters_per_day) {
    litersTarget = Number(recommendationRow.total_liters_per_day);
  }

  if (
    (!Number.isFinite(flowRateLitersPerMinute) || flowRateLitersPerMinute <= 0)
    && Number(recommendationRow?.flow_rate_liters_per_minute) > 0
  ) {
    flowRateLitersPerMinute = Number(recommendationRow?.flow_rate_liters_per_minute);
  }

  if (
    !isStopCommand
    && (!Number.isFinite(durationSeconds) || body.recalculate_duration_from_flow === true)
    && Number.isFinite(litersTarget)
    && litersTarget > 0
    && Number.isFinite(flowRateLitersPerMinute)
    && flowRateLitersPerMinute > 0
  ) {
    durationSeconds = Math.ceil((litersTarget / flowRateLitersPerMinute) * 60);
  }

  if (!isStopCommand && !manualOverride && !sensorAutopilot) {
    const { data: pottedPlant } = await supabase
      .from("potted_plants")
      .select("id,name,analysis_json,flow_rate_liters_per_minute")
      .eq("linked_land_id", landId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pottedPlant?.analysis_json) {
      const { data: latestPottedTelemetry } = await supabase
        .from("iot_telemetry")
        .select("device_uid,soil_moisture_percent,flow_liters_per_minute,valve_state,raw_payload,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const payload = latestPottedTelemetry?.raw_payload && typeof latestPottedTelemetry.raw_payload === "object"
        ? latestPottedTelemetry.raw_payload as Record<string, unknown>
        : {};
      const pottedPreview = buildPottedCommandPreview({
        analysis: structuredClone(pottedPlant.analysis_json),
        flowRateLitersPerMinute: Math.max(
          0.1,
          Number(flowRateLitersPerMinute || latestPottedTelemetry?.flow_liters_per_minute || pottedPlant.flow_rate_liters_per_minute || 1) || 1
        ),
        sensorContext: latestPottedTelemetry
          ? {
            deviceUid: latestPottedTelemetry.device_uid ?? null,
            soilMoisturePercent: latestPottedTelemetry.soil_moisture_percent ?? payload.soil_moisture_percent ?? null,
            tankVolumeLiters: payload.tank_volume_liters ?? null,
            capturedAt: latestPottedTelemetry.captured_at ?? latestPottedTelemetry.created_at ?? null
          }
          : null
      });

      litersTarget = Number(pottedPreview.liters_target ?? 0);
      durationSeconds = Number(pottedPreview.duration_seconds ?? 0);
      flowRateLitersPerMinute = Number(pottedPreview.flow_rate_liters_per_minute ?? flowRateLitersPerMinute);

      if (litersTarget <= 0 || durationSeconds <= 0) {
        return NextResponse.json(
          {
            error: "Potted plant irrigation was blocked because ESP32 soil moisture or the container-safe cap produced 0 L.",
            pottedPlant: { id: pottedPlant.id, name: pottedPlant.name },
            preview: pottedPreview
          },
          { status: 409 }
        );
      }
    }
  }

  if (!Number.isFinite(durationSeconds)) {
    return NextResponse.json(
      { error: "duration_seconds or recommendation_id is required" },
      { status: 400 }
    );
  }

  if (!isStopCommand && (durationSeconds <= 0 || durationSeconds > REQUEST_MAX_DURATION_SECONDS)) {
    return NextResponse.json({ error: `duration_seconds must be 1..${REQUEST_MAX_DURATION_SECONDS}` }, { status: 400 });
  }

  const requestedDurationSeconds = durationSeconds;
  const durationWasSplit = !isStopCommand && durationSeconds > maxDurationSeconds;
  const batchTotalComputed = durationWasSplit ? Math.ceil(durationSeconds / maxDurationSeconds) : null;

  if (durationWasSplit) {
    durationSeconds = maxDurationSeconds;
  }

  const requestedLitersTarget = Number.isFinite(litersTarget) && litersTarget > 0 ? litersTarget : null;
  const commandFlowRate = Number.isFinite(flowRateLitersPerMinute) && flowRateLitersPerMinute > 0
    ? Number(flowRateLitersPerMinute.toFixed(3))
    : null;
  const publishedLitersTarget = requestedLitersTarget && requestedDurationSeconds > 0
    ? Number((requestedLitersTarget * (durationSeconds / requestedDurationSeconds)).toFixed(4))
    : requestedLitersTarget;

  const [landResult, latestAnalysisResult] = await Promise.all([
    supabase
      .from("lands")
      .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,created_at")
      .eq("id", landId)
      .single(),
    supabase
      .from("ai_analyses")
      .select("id,plant_summary,pest_summary,confidence,created_at")
      .eq("land_id", landId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  if (landResult.error) {
    return NextResponse.json({ error: landResult.error.message }, { status: 404 });
  }

  const defaultMqttTopicCommand = `farms/${landId}/devices/${deviceUid}/commands`;
  const defaultMqttTopicAck = `farms/${landId}/devices/${deviceUid}/ack`;
  const { data: landDeviceRow, error: deviceError } = await supabase
    .from("iot_devices")
    .select("id,land_id,device_uid,is_active,last_seen_at,mqtt_topic_command,mqtt_topic_ack")
    .eq("land_id", landId)
    .eq("device_uid", deviceUid)
    .maybeSingle();

  if (deviceError) {
    return NextResponse.json({ error: deviceError.message }, { status: 500 });
  }

  let deviceRow = landDeviceRow;
  let usingSharedDevice = false;

  if (!deviceRow) {
    const { data: sharedDeviceRow, error: sharedDeviceError } = await supabase
      .from("iot_devices")
      .select("id,land_id,device_uid,is_active,last_seen_at,mqtt_topic_command,mqtt_topic_ack")
      .eq("device_uid", deviceUid)
      .maybeSingle();

    if (sharedDeviceError) {
      return NextResponse.json({ error: sharedDeviceError.message }, { status: 500 });
    }

    deviceRow = sharedDeviceRow;
    usingSharedDevice = Boolean(sharedDeviceRow);
  }

  if (!deviceRow) {
    return NextResponse.json(
      { error: "ESP32 is not registered yet. Register it once, or select an existing device from the IoT devices list." },
      { status: 409 }
    );
  }

  const mqttTopicCommand = deviceRow.mqtt_topic_command || defaultMqttTopicCommand;
  const mqttTopicAck = deviceRow.mqtt_topic_ack || defaultMqttTopicAck;

  const { data: latestTelemetry } = await supabase
    .from("iot_telemetry")
    .select("land_id")
    .eq("device_uid", deviceUid)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const emergencyStopTopics = uniqueTopics([
    mqttTopicCommand,
    defaultMqttTopicCommand,
    `farms/${deviceRow.land_id}/devices/${deviceUid}/commands`,
    latestTelemetry?.land_id ? `farms/${latestTelemetry.land_id}/devices/${deviceUid}/commands` : null
  ]);
  const legacyLandId = inferLegacyLandIdFromDeviceUid(deviceUid);
  const commandPublishTopics = uniqueTopics([
    mqttTopicCommand,
    defaultMqttTopicCommand,
    `farms/${deviceRow.land_id}/devices/${deviceUid}/commands`,
    latestTelemetry?.land_id ? `farms/${latestTelemetry.land_id}/devices/${deviceUid}/commands` : null,
    legacyLandId ? `farms/${legacyLandId}/devices/${deviceUid}/commands` : null
  ]);

  const lastSeenMs = deviceRow.last_seen_at ? new Date(deviceRow.last_seen_at).getTime() : NaN;
  const isDeviceOnline = Boolean(
    deviceRow.is_active &&
    Number.isFinite(lastSeenMs) &&
    Date.now() - lastSeenMs <= DEVICE_ONLINE_WINDOW_MS
  );

  if (!isDeviceOnline && !isStopCommand) {
    return NextResponse.json(
      {
        error: "ESP32 is offline or has not sent recent telemetry/ACK. Irrigation command was not published.",
        device_uid: deviceUid,
        last_seen_at: deviceRow.last_seen_at ?? null
      },
      { status: 409 }
    );
  }

  await supabase
    .from("iot_devices")
    .update({
      mqtt_topic_command: mqttTopicCommand,
      mqtt_topic_ack: mqttTopicAck
    })
    .eq("id", deviceRow.id);

  const commandId = randomUUID();
  const safetyReview = isStopCommand
    ? {
        decision: "approve",
        risk_level: "emergency_stop",
        operator_message: "Emergency stop approved: publish OFF command to close the valve immediately.",
        evidence: ["status=OFF", "duration_seconds=0"]
      }
    : sensorAutopilot
    ? {
        decision: "approve",
        risk_level: "sensor_autopilot",
        operator_message: "Sensor autopilot approved: saved recommendation, online ESP32, and low soil moisture triggered irrigation.",
        evidence: [
          "sensor_autopilot=true",
          `recommendation_id=${recommendationRow?.id ?? "none"}`,
          `duration_seconds=${durationSeconds}`,
          `liters_target=${litersTarget}`
        ]
      }
    : manualOverride
    ? {
        decision: "approve",
        risk_level: "manual_override",
        operator_message: "Admin manual override: AI safety gate bypassed by operator.",
        evidence: ["manual_override=true"]
      }
    : await reviewIrrigationCommandSafety({
        land: landResult.data,
        latestAnalysis: latestAnalysisResult.error ? null : latestAnalysisResult.data,
        recommendation: recommendationRow,
        device: {
          id: deviceRow.id,
          device_uid: deviceRow.device_uid,
          topic: mqttTopicCommand
        },
        command: {
          command_id: commandId,
          duration_seconds: durationSeconds,
          max_duration_seconds: maxDurationSeconds
        }
      });

  const payload = {
    command_id: commandId,
    land_id: landId,
    device_uid: deviceUid,
    status: commandStatus,
    duration_seconds: durationSeconds,
    issued_at: new Date().toISOString(),
    reason: isStopCommand
      ? commandReason ?? "Admin emergency stop irrigation command"
      : sensorAutopilot
      ? commandReason ?? (recommendationRow ? `Sensor autopilot recommendation #${recommendationRow.id}` : "Sensor autopilot irrigation command")
      : recommendationRow
      ? `AI irrigation recommendation #${recommendationRow.id}`
      : commandReason ?? (manualOverride ? "Admin manual override irrigation command" : "Manual irrigation command from operator"),
    liters_target: publishedLitersTarget,
    flow_rate_liters_per_minute: commandFlowRate,
    batch: isStopCommand
      ? null
      : Number.isFinite(batch) && batch > 0
      ? {
          current: batch,
          total: Number.isFinite(batchTotal) && batchTotal > 0 ? batchTotal : null
        }
      : durationWasSplit
        ? {
            current: 1,
            total: batchTotalComputed
          }
      : null,
    recommendation: !isStopCommand && recommendationRow
      ? {
          id: recommendationRow.id,
          liters_per_day: recommendationRow.total_liters_per_day,
          flow_rate_liters_per_minute: recommendationRow.flow_rate_liters_per_minute ?? null,
          previous_status: recommendationRow.status
        }
      : null,
    safety: {
      max_duration_seconds: maxDurationSeconds,
      requested_duration_seconds: requestedDurationSeconds,
      requested_liters_target: requestedLitersTarget,
      published_liters_target: publishedLitersTarget,
      flow_rate_liters_per_minute: commandFlowRate,
      shared_device_land_id: usingSharedDevice ? deviceRow.land_id : null,
      duration_was_split: durationWasSplit,
      remaining_duration_seconds: Math.max(0, requestedDurationSeconds - durationSeconds),
      remaining_liters_target: requestedLitersTarget === null ? null : Math.max(0, requestedLitersTarget - Number(publishedLitersTarget ?? 0)),
      require_ack: true,
      manual_override: manualOverride || isStopCommand,
      sensor_autopilot: sensorAutopilot,
      ai_review: safetyReview
    }
  };

  const mqttPayload = {
    command_id: payload.command_id,
    land_id: payload.land_id,
    device_uid: payload.device_uid,
    status: payload.status,
    duration_seconds: payload.duration_seconds,
    issued_at: payload.issued_at,
    reason: payload.reason,
    liters_target: payload.liters_target,
    flow_rate_liters_per_minute: payload.flow_rate_liters_per_minute,
    batch: payload.batch,
    recommendation: payload.recommendation
      ? {
          id: payload.recommendation.id,
          liters_per_day: payload.recommendation.liters_per_day,
          flow_rate_liters_per_minute: payload.recommendation.flow_rate_liters_per_minute
        }
      : null,
    safety: {
      max_duration_seconds: payload.safety.max_duration_seconds,
      require_ack: true,
      manual_override: payload.safety.manual_override,
      sensor_autopilot: payload.safety.sensor_autopilot,
      duration_was_split: payload.safety.duration_was_split
    }
  };

  const { data: commandRow, error: commandError } = await supabase
    .from("iot_commands")
    .insert({
      land_id: landId,
      device_id: deviceRow.id,
      recommendation_id: recommendationRow?.id ?? null,
      command_uuid: commandId,
      payload,
      status: "queued"
    })
    .select("id,command_uuid")
    .single();

  if (commandError) {
    return NextResponse.json({ error: commandError.message }, { status: 500 });
  }

  if (safetyReview?.decision !== "approve") {
    await supabase
      .from("iot_commands")
      .update({
        status: "failed",
        ack_payload: {
          safety_review: safetyReview,
          blocked_at: new Date().toISOString()
        }
      })
      .eq("id", commandRow.id);

    return NextResponse.json(
      {
        error: safetyReview?.operator_message ?? "AI safety review held the irrigation command",
        commandId: commandRow.id,
        commandUuid: commandRow.command_uuid,
        topic: mqttTopicCommand,
        status: "held_by_ai",
        safetyReview
      },
      { status: 409 }
    );
  }

  try {
    const publishedTopics = isStopCommand ? emergencyStopTopics : commandPublishTopics;
    await Promise.all(publishedTopics.map((topic) => publishIrrigationCommand(topic, mqttPayload)));

    const commandUpdate: Record<string, unknown> = {
      status: "published",
      published_at: new Date().toISOString()
    };
    if (isStopCommand) {
      commandUpdate.ack_payload = {
        emergency_stop_topics: publishedTopics,
        published_with_device_online: isDeviceOnline,
        note: "OFF was published to all likely device command topics so a reused ESP32 can stop even if its firmware is still subscribed to an older land topic."
      };
    }

    await supabase
      .from("iot_commands")
      .update(commandUpdate)
      .eq("id", commandRow.id);

    if (!isStopCommand && recommendationRow) {
      await supabase
        .from("irrigation_recommendations")
        .update({ status: "sent_to_iot" })
        .eq("id", recommendationRow.id);
    }

    return NextResponse.json({
      commandId: commandRow.id,
      commandUuid: commandRow.command_uuid,
      topic: mqttTopicCommand,
      topics: isStopCommand ? publishedTopics : [mqttTopicCommand],
      payload,
      mqttPayload,
      status: "published",
      durationWasSplit,
      requestedDurationSeconds,
      publishedDurationSeconds: durationSeconds,
      requestedLitersTarget,
      publishedLitersTarget,
      remainingDurationSeconds: Math.max(0, requestedDurationSeconds - durationSeconds),
      remainingLitersTarget: payload.safety.remaining_liters_target
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MQTT publish failed";
    await supabase
      .from("iot_commands")
      .update({
        status: "failed",
        ack_payload: {
          error: message,
          failed_at: new Date().toISOString(),
          safety_review: safetyReview
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
