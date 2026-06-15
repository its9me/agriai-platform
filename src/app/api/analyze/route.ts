import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { analyzeAgricultureImage } from "@/lib/gemini";
import { calculateIrrigation } from "@/lib/irrigation";
import { getLatestSensorContext } from "@/lib/sensor-context";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

const IMAGERY_BUCKET = "imagery";

function safeStorageName(name: string) {
  const clean = name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean.slice(-90) || "field-image.jpg";
}

async function ensureImageryBucket(supabase: ReturnType<typeof createSupabaseAdmin>) {
  const { error } = await supabase.storage.createBucket(IMAGERY_BUCKET, {
    public: false,
    fileSizeLimit: 15 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]
  });

  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const image = form.get("image");
  const lat = Number(form.get("lat"));
  const lon = Number(form.get("lon"));
  const areaM2 = Number(form.get("areaM2"));
  const cropHint = String(form.get("cropHint") ?? "");
  const landId = Number(form.get("landId"));
  const flowRateLitersPerMinute = Number(form.get("flowRateLitersPerMinute") ?? 10);
  const tankAvailableLiters = Number(form.get("tankAvailableLiters"));
  const tankReserveLiters = Number(form.get("tankReserveLiters") ?? 0);
  const waterSavingPercent = Number(form.get("waterSavingPercent") ?? 70);
  const irrigationMode = String(form.get("irrigationMode") ?? "medium_productivity");

  if (!(image instanceof File)) {
    return NextResponse.json({ error: "image file is required" }, { status: 400 });
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(areaM2)) {
    return NextResponse.json({ error: "lat, lon, and areaM2 are required" }, { status: 400 });
  }

  try {
    const supabase = Number.isFinite(landId) && landId > 0 ? createSupabaseAdmin() : null;
    const sensorContext = supabase ? await getLatestSensorContext(supabase, landId) : null;
    const weather = await getWeather(lat, lon);
    const bytes = Buffer.from(await image.arrayBuffer());
    const imageSha256 = createHash("sha256").update(bytes).digest("hex");
    const analysis = await analyzeAgricultureImage({
      imageBase64: bytes.toString("base64"),
      mimeType: image.type || "image/jpeg",
      land: {
        cropHint,
        areaM2
      },
      weather,
      sensorContext
    });

    const irrigation = calculateIrrigation({
      plants: Array.isArray(analysis.plants) ? analysis.plants : [],
      areaM2,
      forecastRainMm: weather.forecastRainMm,
      flowRateLitersPerMinute,
      tankAvailableLiters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : undefined,
      tankReserveLiters: Number.isFinite(tankReserveLiters) ? tankReserveLiters : undefined,
      waterSavingPercent: Number.isFinite(waterSavingPercent) ? waterSavingPercent : undefined,
      irrigationMode,
      agronomicContext: weather.agronomic,
      sensorContext
    });

    let saved: null | {
      imageryId: number | null;
      imagePath: string | null;
      aiAnalysisId: number;
      recommendationId: number;
      duplicateImage?: boolean;
    } = null;

    if (Number.isFinite(landId) && landId > 0) {
      if (!supabase) throw new Error("Supabase admin client is not available");
      await ensureImageryBucket(supabase);

      const capturedAt = new Date().toISOString();
      const { data: duplicateImagery, error: duplicateError } = await supabase
        .from("imagery")
        .select("id,image_url")
        .eq("land_id", landId)
        .filter("metadata->>sha256", "eq", imageSha256)
        .maybeSingle();

      if (duplicateError) throw duplicateError;

      let imageryRow = duplicateImagery;
      let storagePath = duplicateImagery?.image_url ?? "";

      if (!imageryRow) {
        storagePath = `lands/${landId}/${Date.now()}-${safeStorageName(image.name)}`;
        const { error: uploadError } = await supabase.storage
          .from(IMAGERY_BUCKET)
          .upload(storagePath, bytes, {
            contentType: image.type || "image/jpeg",
            upsert: false
          });

        if (uploadError) throw uploadError;

        const { data: insertedImagery, error: imageryError } = await supabase
          .from("imagery")
          .insert({
            land_id: landId,
            uploaded_by: null,
            image_url: storagePath,
            source: "manual",
            captured_at: capturedAt,
            metadata: {
              bucket: IMAGERY_BUCKET,
              originalName: image.name,
              mimeType: image.type || "image/jpeg",
              size: image.size,
              sha256: imageSha256
            }
          })
          .select("id,image_url")
          .single();

        if (imageryError) throw imageryError;
        imageryRow = insertedImagery;
      }

      const { data: aiRow, error: aiError } = await supabase
        .from("ai_analyses")
        .insert({
          land_id: landId,
          imagery_id: imageryRow.id,
          model_name: "gemini-2.5-flash",
          plant_summary: { plants: analysis.plants ?? [] },
          pest_summary: analysis.pests ?? {},
          weather_snapshot: { ...weather, sensorContext },
          raw_ai_json: analysis,
          confidence: Number(analysis.overall_confidence ?? 0)
        })
        .select("id")
        .single();

      if (aiError) throw aiError;

      const { data: recRow, error: recError } = await supabase
        .from("irrigation_recommendations")
        .insert({
          land_id: landId,
          ai_analysis_id: aiRow.id,
          total_liters_per_day: irrigation.totalLitersPerDay,
          rain_deduction_liters: irrigation.rainDeductionLiters,
          recommended_duration_seconds: irrigation.recommendedIrrigationDurationSeconds,
          flow_rate_liters_per_minute: flowRateLitersPerMinute,
          reason: `Generated from Gemini visual analysis, OpenWeather forecast, and latest ESP32 soil moisture when available. Soil moisture ${irrigation.soilMoisturePercent ?? "n/a"}%; moisture factor ${irrigation.soilMoistureAdjustmentFactor.toFixed(2)}; moisture deduction ${irrigation.soilMoistureDeductionLiters.toFixed(1)} L. Raw one irrigation ${irrigation.rawTotalLitersPerIrrigation.toFixed(1)} L; irrigation mode ${irrigation.irrigationModeLabel} (${irrigation.waterSavingPercent.toFixed(0)}% of full target); planned daily average ${irrigation.totalLitersPerDay.toFixed(1)} L; one irrigation ${irrigation.totalLitersPerIrrigation.toFixed(1)} L every ${irrigation.irrigationIntervalDays} day(s). Tank executable ${irrigation.executableLiters.toFixed(1)} L; shortage ${irrigation.tankShortageLiters.toFixed(1)} L.`,
          status: "pending"
        })
        .select("id")
        .single();

      if (recError) throw recError;
      saved = {
        imageryId: imageryRow.id,
        imagePath: storagePath,
        aiAnalysisId: aiRow.id,
        recommendationId: recRow.id,
        duplicateImage: Boolean(duplicateImagery)
      };
    }

    return NextResponse.json({
      analysis,
      weather,
      sensorContext,
      irrigation,
      saved
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
