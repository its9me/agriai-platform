import type { createSupabaseAdmin } from "./supabase-server";

type SupabaseAdmin = ReturnType<typeof createSupabaseAdmin>;

function numberOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export type LatestSensorContext = {
  deviceUid: string | null;
  soilMoisturePercent: number | null;
  tankLevelPercent: number | null;
  tankVolumeLiters: number | null;
  flowLitersPerMinute: number | null;
  valveState: string | null;
  capturedAt: string | null;
  source: "iot_telemetry";
};

export async function getLatestSensorContext(
  supabase: SupabaseAdmin,
  landId: number
): Promise<LatestSensorContext | null> {
  if (!Number.isFinite(landId) || landId <= 0) return null;

  const { data, error } = await supabase
    .from("iot_telemetry")
    .select("device_uid,soil_moisture_percent,tank_level_percent,tank_volume_liters,flow_liters_per_minute,valve_state,raw_payload,captured_at,created_at")
    .eq("land_id", landId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const payload = data.raw_payload && typeof data.raw_payload === "object" ? data.raw_payload : {};

  return {
    deviceUid: typeof data.device_uid === "string" ? data.device_uid : null,
    soilMoisturePercent: numberOrNull(data.soil_moisture_percent ?? payload.soil_moisture_percent),
    tankLevelPercent: numberOrNull(data.tank_level_percent ?? payload.tank_level_percent),
    tankVolumeLiters: numberOrNull(data.tank_volume_liters ?? payload.tank_volume_liters),
    flowLitersPerMinute: numberOrNull(data.flow_liters_per_minute ?? payload.flow_liters_per_minute),
    valveState: typeof data.valve_state === "string" ? data.valve_state : null,
    capturedAt: data.captured_at ?? data.created_at ?? null,
    source: "iot_telemetry"
  };
}

export function soilMoistureIrrigationFactor(soilMoisturePercent: unknown) {
  const percent = Number(soilMoisturePercent);
  if (!Number.isFinite(percent)) return 1;
  if (percent >= 70) return 0;
  if (percent >= 55) return 0.4;
  if (percent >= 40) return 0.75;
  if (percent <= 20) return 1.1;
  return 1;
}
