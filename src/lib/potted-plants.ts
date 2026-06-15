import { createHash } from "crypto";
import { analyzePottedPlantImage } from "./gemini";
import { getLatestSensorContext, soilMoistureIrrigationFactor } from "./sensor-context";
import type { createSupabaseAdmin } from "./supabase-server";

export const POTTED_PLANTS_BUCKET = "imagery";

type SupabaseAdmin = ReturnType<typeof createSupabaseAdmin>;

function midpointRange(range: unknown) {
  if (!range || typeof range !== "object") return null;
  const min = Number((range as { min?: unknown }).min);
  const max = Number((range as { max?: unknown }).max);
  if (Number.isFinite(min) && Number.isFinite(max)) return (min + max) / 2;
  if (Number.isFinite(min)) return min;
  if (Number.isFinite(max)) return max;
  return null;
}

function clampPottedWaterLiters(input: {
  requestedLiters: number;
  analysis: any;
}) {
  const soilVolume = midpointRange(input.analysis?.soil?.estimated_soil_volume_liters);
  const containerVolume = midpointRange(input.analysis?.container?.estimated_volume_liters);
  const caps = [
    Number.isFinite(Number(soilVolume)) && Number(soilVolume) > 0 ? Number(soilVolume) * 0.22 : null,
    Number.isFinite(Number(containerVolume)) && Number(containerVolume) > 0 ? Number(containerVolume) * 0.18 : null
  ].filter((value): value is number => Number.isFinite(Number(value)) && Number(value) > 0);
  const hardCapLiters = caps.length ? Math.min(...caps) : 0.45;

  return Math.max(0, Math.min(input.requestedLiters, hardCapLiters));
}

export function safePottedPlantStorageName(name: string) {
  const clean = name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean.slice(-90) || "potted-plant.jpg";
}

export async function ensurePottedPlantBucket(supabase: SupabaseAdmin) {
  const { error } = await supabase.storage.createBucket(POTTED_PLANTS_BUCKET, {
    public: false,
    fileSizeLimit: 15 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]
  });

  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw error;
  }
}

export function buildPottedCommandPreview(input: {
  analysis: any;
  flowRateLitersPerMinute: number;
  sensorContext: unknown;
}) {
  const irrigation = input.analysis?.irrigation && typeof input.analysis.irrigation === "object"
    ? input.analysis.irrigation as {
        recommended_liters_now?: { min?: number; max?: number; best?: number };
        watering_percent_of_soil_volume?: number;
      }
    : {};
  const bestLiters = Number(irrigation.recommended_liters_now?.best ?? midpointRange(irrigation.recommended_liters_now));
  const rawBestLiters = Number.isFinite(bestLiters) ? Math.max(0, bestLiters) : 0;
  const cappedRawLiters = clampPottedWaterLiters({
    requestedLiters: rawBestLiters,
    analysis: input.analysis
  });
  const soilMoisturePercent = input.sensorContext && typeof input.sensorContext === "object"
    ? (input.sensorContext as { soilMoisturePercent?: unknown }).soilMoisturePercent
    : null;
  const soilMoistureFactor = soilMoistureIrrigationFactor(soilMoisturePercent);
  const adjustedBestLiters = Math.max(0, cappedRawLiters * soilMoistureFactor);
  const durationSeconds = adjustedBestLiters > 0
    ? Math.ceil((adjustedBestLiters / input.flowRateLitersPerMinute) * 60)
    : 0;

  if (input.analysis?.irrigation && typeof input.analysis.irrigation === "object") {
    input.analysis.irrigation.recommended_liters_now = {
      ...(input.analysis.irrigation.recommended_liters_now ?? {}),
      best: Number(adjustedBestLiters.toFixed(3))
    };
    input.analysis.irrigation.safety_notes = [
      ...(Array.isArray(input.analysis.irrigation.safety_notes) ? input.analysis.irrigation.safety_notes : []),
      soilMoisturePercent !== null && soilMoisturePercent !== undefined
        ? `تم تعديل كمية الري حسب قراءة حساس رطوبة التربة: ${Number(soilMoisturePercent).toFixed(0)}%.`
        : "لم تتوفر قراءة رطوبة تربة من حساس ESP32 لهذا النبات. لم يتم استخدام بيانات رطوبة Open-Meteo للنباتات الداخلية."
    ];
  }

  return {
    liters_target: Number(adjustedBestLiters.toFixed(3)),
    raw_liters_target: Number(rawBestLiters.toFixed(3)),
    capped_raw_liters_target: Number(cappedRawLiters.toFixed(3)),
    container_safe_cap_liters: Number(cappedRawLiters.toFixed(3)),
    duration_seconds: durationSeconds,
    flow_rate_liters_per_minute: input.flowRateLitersPerMinute,
    watering_percent_of_soil_volume: Number(irrigation.watering_percent_of_soil_volume ?? 0),
    soil_moisture_percent: soilMoisturePercent ?? null,
    soil_moisture_adjustment_factor: soilMoistureFactor,
    moisture_source: soilMoisturePercent !== null && soilMoisturePercent !== undefined ? "esp32_sensor" : "not_available"
  };
}

export async function analyzePottedPlantFromBytes(input: {
  supabase: SupabaseAdmin;
  bytes: Buffer;
  mimeType: string;
  flowRateLitersPerMinute: number;
  notes: string;
  linkedLandId?: number | null;
}) {
  const sensorContext = input.linkedLandId && Number.isFinite(input.linkedLandId)
    ? await getLatestSensorContext(input.supabase, input.linkedLandId)
    : null;
  const analysis = await analyzePottedPlantImage({
    imageBase64: input.bytes.toString("base64"),
    mimeType: input.mimeType || "image/jpeg",
    context: {
      flowRateLitersPerMinute: input.flowRateLitersPerMinute,
      notes: input.notes,
      sensorContext,
      moisturePolicy: "For potted/indoor plants use ESP32 soil sensor only. Do not use Open-Meteo soil moisture."
    }
  });
  const commandPreview = buildPottedCommandPreview({
    analysis,
    flowRateLitersPerMinute: input.flowRateLitersPerMinute,
    sensorContext
  });

  return { analysis, commandPreview, sensorContext };
}

export async function savePottedIrrigationRecommendation(input: {
  supabase: SupabaseAdmin;
  landId: number | null | undefined;
  commandPreview: any;
  flowRateLitersPerMinute: number;
  sourceLabel?: string;
}) {
  const landId = Number(input.landId);
  if (!Number.isFinite(landId) || landId <= 0) return null;
  if (!input.commandPreview || typeof input.commandPreview !== "object") return null;

  const litersTarget = Math.max(0, Number(input.commandPreview?.liters_target ?? 0));
  const rawLitersTarget = Math.max(0, Number(input.commandPreview?.raw_liters_target ?? litersTarget));
  const durationSeconds = Math.max(0, Math.ceil(Number(input.commandPreview?.duration_seconds ?? 0)));
  const flowRateLitersPerMinute = Math.max(0.1, Number(input.flowRateLitersPerMinute ?? input.commandPreview?.flow_rate_liters_per_minute ?? 10) || 10);
  const soilMoisture = input.commandPreview?.soil_moisture_percent;
  const moistureFactor = Number(input.commandPreview?.soil_moisture_adjustment_factor ?? 1);

  const { data, error } = await input.supabase
    .from("irrigation_recommendations")
    .insert({
      land_id: landId,
      ai_analysis_id: null,
      total_liters_per_day: litersTarget,
      rain_deduction_liters: 0,
      recommended_duration_seconds: durationSeconds,
      flow_rate_liters_per_minute: flowRateLitersPerMinute,
      reason: `${input.sourceLabel ?? "Generated from saved potted plant analysis"} using ESP32 soil sensor only. Soil moisture ${soilMoisture ?? "n/a"}%; moisture factor ${Number.isFinite(moistureFactor) ? moistureFactor.toFixed(2) : "n/a"}; raw target ${rawLitersTarget.toFixed(2)} L; adjusted target ${litersTarget.toFixed(2)} L. Indoor/potted mode does not use Open-Meteo soil moisture.`,
      status: "pending"
    })
    .select("id,total_liters_per_day,recommended_duration_seconds,status,created_at")
    .single();

  if (error) throw error;
  return data;
}

export function inferPottedPlantName(analysis: any, fallback: string) {
  return String(
    analysis?.plant?.arabic_name
    || analysis?.plant?.name
    || fallback
    || "نبات مفرد"
  ).trim();
}

export function imageSha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
