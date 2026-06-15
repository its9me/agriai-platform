import { NextRequest, NextResponse } from "next/server";
import { POST as publishIrrigationCommandRoute } from "@/app/api/iot/command/route";
import { buildPottedCommandPreview } from "@/lib/potted-plants";
import { createSupabaseAdmin } from "@/lib/supabase-server";

const DEFAULT_AUTO_MOISTURE_THRESHOLD_PERCENT = 35;
const DEFAULT_AUTO_MOISTURE_IDEAL_PERCENT = 55;
const AUTO_RECOMMENDATION_HYSTERESIS_PERCENT = 5;
const CLOSED_LOOP_MEMORY_MS = 30 * 60 * 1000;
const COMMAND_PUBLISH_ACK_TIMEOUT_MS = 2 * 60 * 1000;

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number | null) {
  if (value === null) return null;
  return Math.min(100, Math.max(0, value));
}

function tankReadingFromBody(body: Record<string, unknown>) {
  const capacity = optionalNumber(body.tank_capacity_liters);
  const volume = optionalNumber(body.tank_volume_liters);
  const levelPercent = clampPercent(optionalNumber(body.tank_level_percent));
  const computedVolume = volume ?? (capacity !== null && levelPercent !== null
    ? capacity * (levelPercent / 100)
    : null);

  return {
    tank_capacity_liters: capacity,
    tank_volume_liters: computedVolume,
    tank_level_percent: levelPercent,
    tank_sensor_source: typeof body.tank_sensor_source === "string" ? body.tank_sensor_source : null
  };
}

function resolveAutoMoistureThreshold(raw: unknown) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) return Math.max(5, Math.min(80, parsed));
  const fromEnv = Number(process.env.AUTO_IRRIGATION_MOISTURE_THRESHOLD_PERCENT);
  if (Number.isFinite(fromEnv)) return Math.max(5, Math.min(80, fromEnv));
  return DEFAULT_AUTO_MOISTURE_THRESHOLD_PERCENT;
}

type MoisturePolicy = {
  triggerPercent: number;
  refreshAbovePercent: number;
  idealPercent: number;
  label: string;
};

type RecentCommand = {
  id: number;
  status: string | null;
  created_at: string | null;
  payload: unknown;
  ack_payload: unknown;
};

function normalizeArabicAndEnglishText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function resolveMoisturePolicy(input: {
  explicitThreshold: unknown;
  landName: unknown;
  cropHint: unknown;
  pottedPlantName?: unknown;
  pottedAnalysis?: unknown;
}): MoisturePolicy {
  const name = normalizeArabicAndEnglishText(`${input.pottedPlantName ?? ""} ${input.landName ?? ""} ${input.cropHint ?? ""}`);
  const analysisPlant = input.pottedAnalysis && typeof input.pottedAnalysis === "object"
    ? (input.pottedAnalysis as { plant?: { name?: unknown; arabic_name?: unknown } }).plant
    : null;
  const plantName = normalizeArabicAndEnglishText(`${analysisPlant?.name ?? ""} ${analysisPlant?.arabic_name ?? ""}`);
  const text = `${name} ${plantName}`;
  const explicit = resolveAutoMoistureThreshold(input.explicitThreshold);

  if (/portulaca|purslane|بورتولاكا|رجلة/.test(text)) {
    return {
      triggerPercent: Math.min(explicit, 25),
      refreshAbovePercent: Math.min(explicit, 25) + AUTO_RECOMMENDATION_HYSTERESIS_PERCENT,
      idealPercent: 40,
      label: "potted_drought_tolerant"
    };
  }

  if (/cactus|succulent|صبار|عصاري/.test(text)) {
    return {
      triggerPercent: Math.min(explicit, 22),
      refreshAbovePercent: Math.min(explicit, 22) + AUTO_RECOMMENDATION_HYSTERESIS_PERCENT,
      idealPercent: 35,
      label: "potted_succulent"
    };
  }

  if (/mint|basil|lettuce|نعناع|ريحان|خس|ورقي/.test(text)) {
    return {
      triggerPercent: Math.max(explicit, 38),
      refreshAbovePercent: Math.max(explicit, 38) + AUTO_RECOMMENDATION_HYSTERESIS_PERCENT,
      idealPercent: 58,
      label: "leafy_or_herb"
    };
  }

  return {
    triggerPercent: explicit,
    refreshAbovePercent: explicit + AUTO_RECOMMENDATION_HYSTERESIS_PERCENT,
    idealPercent: Math.max(DEFAULT_AUTO_MOISTURE_IDEAL_PERCENT, explicit + 15),
    label: "default"
  };
}

function ackStatus(ackPayload: unknown) {
  if (!ackPayload || typeof ackPayload !== "object") return "";
  return String((ackPayload as { status?: unknown }).status ?? "").toLowerCase();
}

function commandPayload(command: RecentCommand) {
  return command.payload && typeof command.payload === "object"
    ? command.payload as Record<string, unknown>
    : {};
}

function commandSafety(payload: Record<string, unknown>) {
  return payload.safety && typeof payload.safety === "object"
    ? payload.safety as Record<string, unknown>
    : {};
}

function isCommandInFlight(command: RecentCommand) {
  const status = String(command.status ?? "").toLowerCase();
  const payload = commandPayload(command);
  const requestedStatus = String(payload.status ?? "ON").toUpperCase();
  if (requestedStatus !== "ON") return false;
  if (status === "queued" || status === "published") {
    const createdAtMs = command.created_at ? new Date(command.created_at).getTime() : 0;
    const isStale = Number.isFinite(createdAtMs) && Date.now() - createdAtMs > COMMAND_PUBLISH_ACK_TIMEOUT_MS;
    return !isStale;
  }
  if (status !== "acknowledged") return false;
  const ack = ackStatus(command.ack_payload);
  return !["completed", "forced_off", "stopped", "cancelled", "failed", "rejected"].includes(ack);
}

function isClosedLoopCommand(command: RecentCommand) {
  const payload = commandPayload(command);
  const safety = commandSafety(payload);
  const reason = String(payload.reason ?? "").toLowerCase();
  return safety.sensor_autopilot === true || reason.includes("sensor autopilot") || reason.includes("closed-loop");
}

async function createPottedClosedLoopRecommendation(input: {
  supabase: ReturnType<typeof createSupabaseAdmin>;
  landId: number;
  pottedPlant: {
    id: number;
    name: string | null;
    analysis_json: unknown;
    flow_rate_liters_per_minute: number | null;
  };
  soilMoisturePercent: number;
  tankVolumeLiters: number | null;
  flowRateLitersPerMinute: number | null;
  policy: MoisturePolicy;
}) {
  if (!input.pottedPlant.analysis_json || typeof input.pottedPlant.analysis_json !== "object") {
    return { recommendation: null, preview: null, reason: "potted_analysis_missing" };
  }

  const flowRate = Math.max(
    0.1,
    Number(input.flowRateLitersPerMinute ?? input.pottedPlant.flow_rate_liters_per_minute ?? 1) || 1
  );
  const preview = buildPottedCommandPreview({
    analysis: structuredClone(input.pottedPlant.analysis_json),
    flowRateLitersPerMinute: flowRate,
    sensorContext: {
      soilMoisturePercent: input.soilMoisturePercent,
      tankVolumeLiters: input.tankVolumeLiters,
      source: "iot_telemetry"
    }
  });
  const litersTarget = Number(preview.liters_target ?? 0);
  const durationSeconds = Number(preview.duration_seconds ?? 0);

  if (litersTarget <= 0 || durationSeconds <= 0) {
    return {
      recommendation: null,
      preview,
      reason: "live_potted_preview_zero_water"
    };
  }

  const { data, error } = await input.supabase
    .from("irrigation_recommendations")
    .insert({
      land_id: input.landId,
      ai_analysis_id: null,
      total_liters_per_day: litersTarget,
      rain_deduction_liters: 0,
      recommended_duration_seconds: durationSeconds,
      flow_rate_liters_per_minute: flowRate,
      reason: `Closed-loop sensor autopilot recommendation for ${input.pottedPlant.name ?? "potted plant"}. ESP32 soil moisture ${input.soilMoisturePercent.toFixed(0)}%; trigger ${input.policy.triggerPercent.toFixed(0)}%; ideal ${input.policy.idealPercent.toFixed(0)}%; container-safe target ${litersTarget.toFixed(2)} L.`,
      status: "pending"
    })
    .select("id,total_liters_per_day,recommended_duration_seconds,flow_rate_liters_per_minute,status,created_at")
    .single();

  if (error) throw error;
  return { recommendation: data, preview, reason: "live_potted_recommendation_created" };
}

async function maybeTriggerAutoIrrigation(input: {
  requestUrl: string;
  supabase: ReturnType<typeof createSupabaseAdmin>;
  landId: number;
  deviceUid: string;
  deviceId: number;
  soilMoisturePercent: number | null;
  valveState: string;
  tankVolumeLiters: number | null;
  flowRateLitersPerMinute: number | null;
}) {
  const soilMoisturePercent = input.soilMoisturePercent;
  if (!Number.isFinite(Number(soilMoisturePercent))) {
    return { triggered: false, reason: "no_soil_moisture_reading" };
  }

  if (input.valveState === "ON") {
    return { triggered: false, reason: "valve_already_on" };
  }

  const { data: land, error: landError } = await input.supabase
    .from("lands")
    .select("id,name,crop_hint,auto_irrigation_enabled")
    .eq("id", input.landId)
    .maybeSingle();

  if (landError) return { triggered: false, reason: "land_lookup_failed", error: landError.message };
  if (!land?.auto_irrigation_enabled) return { triggered: false, reason: "auto_irrigation_disabled" };

  const { data: pottedPlant } = await input.supabase
    .from("potted_plants")
    .select("id,name,analysis_json,flow_rate_liters_per_minute")
    .eq("linked_land_id", input.landId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const policy = resolveMoisturePolicy({
    explicitThreshold: (land as Record<string, unknown>).auto_moisture_threshold_percent,
    landName: land.name,
    cropHint: land.crop_hint,
    pottedPlantName: pottedPlant?.name,
    pottedAnalysis: pottedPlant?.analysis_json
  });

  const { data: recentCommands, error: commandsError } = await input.supabase
    .from("iot_commands")
    .select("id,status,created_at,payload,ack_payload")
    .eq("land_id", input.landId)
    .eq("device_id", input.deviceId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (commandsError) {
    return { triggered: false, reason: "recent_command_lookup_failed", error: commandsError.message };
  }

  const recentActiveCommand = (recentCommands ?? []).find((command) => isCommandInFlight(command as RecentCommand));

  if (recentActiveCommand) {
    return {
      triggered: false,
      reason: "irrigation_command_in_flight",
      recentCommandId: recentActiveCommand.id,
      soilMoisturePercent,
      moisturePolicy: policy
    };
  }

  const closedLoopRecentlyActive = (recentCommands ?? []).some((command) => {
    const createdAtMs = command.created_at ? new Date(command.created_at).getTime() : 0;
    return Number.isFinite(createdAtMs)
      && Date.now() - createdAtMs <= CLOSED_LOOP_MEMORY_MS
      && isClosedLoopCommand(command as RecentCommand);
  });

  const currentMoisture = Number(soilMoisturePercent);
  const shouldStartClosedLoop = currentMoisture <= policy.triggerPercent;
  const shouldContinueClosedLoop = closedLoopRecentlyActive && currentMoisture < policy.idealPercent;
  const shouldRefreshRecommendation = shouldStartClosedLoop || shouldContinueClosedLoop;

  if (currentMoisture >= policy.idealPercent) {
    return {
      triggered: false,
      reason: "ideal_soil_moisture_reached",
      soilMoisturePercent,
      moisturePolicy: policy
    };
  }

  if (!shouldRefreshRecommendation && currentMoisture >= policy.refreshAbovePercent) {
    return {
      triggered: false,
      reason: "soil_moisture_above_refresh_band_reuse_previous_recommendation",
      soilMoisturePercent,
      moisturePolicy: policy
    };
  }

  if (!shouldRefreshRecommendation) {
    return {
      triggered: false,
      reason: "soil_moisture_between_trigger_and_refresh_band_waiting",
      soilMoisturePercent,
      moisturePolicy: policy
    };
  }

  let recommendation: {
    id: number;
    total_liters_per_day: number;
    recommended_duration_seconds: number;
    flow_rate_liters_per_minute: number | null;
    status: string | null;
    created_at: string | null;
  } | null = null;
  let recommendationSource = "latest_saved_recommendation";
  let livePreview: unknown = null;

  if (pottedPlant?.analysis_json) {
    try {
      const live = await createPottedClosedLoopRecommendation({
        supabase: input.supabase,
        landId: input.landId,
        pottedPlant: {
          id: Number(pottedPlant.id),
          name: pottedPlant.name ?? null,
          analysis_json: pottedPlant.analysis_json,
          flow_rate_liters_per_minute: Number(pottedPlant.flow_rate_liters_per_minute ?? 0) || null
        },
        soilMoisturePercent: currentMoisture,
        tankVolumeLiters: input.tankVolumeLiters,
        flowRateLitersPerMinute: input.flowRateLitersPerMinute,
        policy
      });
      livePreview = live.preview;
      if (live.recommendation) {
        recommendation = live.recommendation;
        recommendationSource = live.reason;
      } else {
        return {
          triggered: false,
          reason: live.reason,
          soilMoisturePercent,
          moisturePolicy: policy,
          preview: livePreview
        };
      }
    } catch (error) {
      return {
        triggered: false,
        reason: "live_potted_recommendation_failed",
        error: error instanceof Error ? error.message : "Unknown potted recommendation error",
        soilMoisturePercent,
        moisturePolicy: policy
      };
    }
  }

  if (!recommendation) {
    const { data, error: recommendationError } = await input.supabase
      .from("irrigation_recommendations")
      .select("id,total_liters_per_day,recommended_duration_seconds,flow_rate_liters_per_minute,status,created_at")
      .eq("land_id", input.landId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recommendationError) {
      return { triggered: false, reason: "recommendation_lookup_failed", error: recommendationError.message };
    }
    recommendation = data ?? null;
  }

  if (!recommendation) return { triggered: false, reason: "no_irrigation_recommendation" };

  const litersTarget = Number(recommendation.total_liters_per_day ?? 0);
  const durationSeconds = Number(recommendation.recommended_duration_seconds ?? 0);
  if (litersTarget <= 0 || durationSeconds <= 0) {
    return {
      triggered: false,
      reason: "recommendation_has_no_water",
      recommendationId: recommendation.id,
      litersTarget,
      durationSeconds
    };
  }

  if (Number.isFinite(Number(input.tankVolumeLiters)) && Number(input.tankVolumeLiters) <= 0) {
    return {
      triggered: false,
      reason: "tank_empty",
      tankVolumeLiters: input.tankVolumeLiters
    };
  }

  const commandRequest = new NextRequest(new URL("/api/iot/command", input.requestUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      land_id: input.landId,
      device_uid: input.deviceUid,
      recommendation_id: recommendation.id,
      duration_seconds: durationSeconds,
      liters_target: litersTarget,
      flow_rate_liters_per_minute: input.flowRateLitersPerMinute ?? recommendation.flow_rate_liters_per_minute ?? undefined,
      recalculate_duration_from_flow: recommendationSource !== "live_potted_recommendation_created",
      sensor_autopilot: true,
      reason: `Closed-loop sensor autopilot: soil moisture ${currentMoisture.toFixed(0)}%, trigger ${policy.triggerPercent.toFixed(0)}%, ideal ${policy.idealPercent.toFixed(0)}%.`
    })
  });

  const commandResponse = await publishIrrigationCommandRoute(commandRequest);
  const commandPayload = await commandResponse.json().catch(() => ({}));

  return {
    triggered: commandResponse.ok,
    reason: commandResponse.ok ? "published" : "publish_failed",
    soilMoisturePercent,
    moisturePolicy: policy,
    recommendationSource,
    recommendationId: recommendation.id,
    preview: livePreview,
    command: commandPayload,
    status: commandResponse.status
  };
}

export async function POST(request: NextRequest) {
  const expectedToken = process.env.IOT_INGEST_TOKEN;
  if (expectedToken) {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const headerToken = request.headers.get("x-iot-token")?.trim();
    if ((bearer || headerToken) !== expectedToken) {
      return NextResponse.json({ error: "Invalid IoT telemetry token" }, { status: 401 });
    }
  }

  const body = await request.json();
  const landId = Number(body.land_id);
  const deviceUid = String(body.device_uid ?? "").trim();

  if (!Number.isFinite(landId) || !deviceUid) {
    return NextResponse.json(
      { error: "land_id and device_uid are required" },
      { status: 400 }
    );
  }

  const valveState = String(body.valve_state ?? "unknown").toUpperCase();
  const normalizedValveState = valveState === "ON" || valveState === "OFF" ? valveState : "unknown";
  const capturedAt = body.captured_at ? new Date(String(body.captured_at)) : new Date();

  if (Number.isNaN(capturedAt.getTime())) {
    return NextResponse.json({ error: "captured_at must be a valid date" }, { status: 400 });
  }

  const supabase = createSupabaseAdmin();
  const mqttTopicCommand = `farms/${landId}/devices/${deviceUid}/commands`;
  const mqttTopicAck = `farms/${landId}/devices/${deviceUid}/ack`;
  const tankReading = tankReadingFromBody(body);

  const { data: existingDevice, error: existingDeviceError } = await supabase
    .from("iot_devices")
    .select("id,device_uid,last_seen_at")
    .eq("device_uid", deviceUid)
    .maybeSingle();

  if (existingDeviceError) {
    return NextResponse.json({ error: existingDeviceError.message }, { status: 500 });
  }

  const deviceResult = existingDevice
    ? await supabase
        .from("iot_devices")
        .update({
          is_active: true,
          last_seen_at: capturedAt.toISOString()
        })
        .eq("id", existingDevice.id)
        .select("id,device_uid,last_seen_at")
        .single()
    : await supabase
        .from("iot_devices")
        .insert({
          land_id: landId,
          device_uid: deviceUid,
          mqtt_topic_command: mqttTopicCommand,
          mqtt_topic_ack: mqttTopicAck,
          is_active: true,
          last_seen_at: capturedAt.toISOString()
        })
        .select("id,device_uid,last_seen_at")
        .single();

  const { data: deviceRow, error: deviceError } = deviceResult;

  if (deviceError) {
    return NextResponse.json({ error: deviceError.message }, { status: 500 });
  }

  const row = {
    land_id: landId,
    device_id: deviceRow.id,
    device_uid: deviceUid,
    soil_moisture_percent: clampPercent(optionalNumber(body.soil_moisture_percent)),
    temperature_c: optionalNumber(body.temperature_c),
    humidity_percent: clampPercent(optionalNumber(body.humidity_percent)),
    flow_liters_per_minute: optionalNumber(body.flow_liters_per_minute),
    valve_state: normalizedValveState,
    battery_percent: clampPercent(optionalNumber(body.battery_percent)),
    raw_payload: body,
    captured_at: capturedAt.toISOString()
  };
  const rowWithTank = {
    ...row,
    tank_level_percent: tankReading.tank_level_percent,
    tank_volume_liters: tankReading.tank_volume_liters,
    tank_capacity_liters: tankReading.tank_capacity_liters,
    tank_sensor_source: tankReading.tank_sensor_source
  };

  let { data: telemetryRow, error: telemetryError } = await supabase
    .from("iot_telemetry")
    .insert(rowWithTank)
    .select("id,captured_at")
    .single();

  if (telemetryError && /tank_|column|schema/i.test(telemetryError.message)) {
    const retry = await supabase
      .from("iot_telemetry")
      .insert(row)
      .select("id,captured_at")
      .single();
    telemetryRow = retry.data;
    telemetryError = retry.error;
  }

  if (telemetryError) {
    const isMissingTable = telemetryError.message.toLowerCase().includes("iot_telemetry");
    return NextResponse.json(
      {
        error: isMissingTable
          ? "جدول iot_telemetry غير موجود. شغّل آخر تحديث من supabase/schema.sql داخل Supabase SQL Editor."
          : telemetryError.message
      },
      { status: 500 }
    );
  }

  if (!telemetryRow) {
    return NextResponse.json({ error: "Telemetry was not stored" }, { status: 500 });
  }

  return NextResponse.json({
    telemetryId: telemetryRow.id,
    deviceId: deviceRow.id,
    deviceUid,
    capturedAt: telemetryRow.captured_at,
    tank: tankReading,
    autoIrrigation: await maybeTriggerAutoIrrigation({
      requestUrl: request.url,
      supabase,
      landId,
      deviceUid,
      deviceId: deviceRow.id,
      soilMoisturePercent: row.soil_moisture_percent,
      valveState: normalizedValveState,
      tankVolumeLiters: tankReading.tank_volume_liters,
      flowRateLitersPerMinute: row.flow_liters_per_minute
    }),
    status: "stored"
  });
}
