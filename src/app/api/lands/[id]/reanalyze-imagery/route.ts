import { NextRequest, NextResponse } from "next/server";
import { analyzeAgricultureImage } from "@/lib/gemini";
import { calculateIrrigation } from "@/lib/irrigation";
import { getLatestSensorContext } from "@/lib/sensor-context";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function uniqueImagery(items: any[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const key = metadata.sha256
      || (metadata.originalName && metadata.size ? `${metadata.originalName}:${metadata.size}` : null)
      || metadata.originalName
      || item.image_url
      || item.id;
    if (seen.has(String(key))) return false;
    seen.add(String(key));
    return true;
  });
}

function aggregatePlants(analyses: any[]) {
  const groups = new Map<string, { name: string; count: number }>();

  for (const analysis of analyses) {
    const plants = Array.isArray(analysis.plant_summary?.plants)
      ? analysis.plant_summary.plants
      : [];

    for (const plant of plants) {
      const name = String(plant.name ?? "unknown").trim();
      const key = name.toLowerCase();
      const count = Math.max(0, Number(plant.count ?? 0));
      const current = groups.get(key);
      groups.set(key, {
        name,
        count: Math.max(current?.count ?? 0, count)
      });
    }
  }

  return Array.from(groups.values());
}

function manualPlants(plants: any[]) {
  return plants.map((plant) => ({
    name: plant.name,
    count: Number(plant.count ?? 0)
  }));
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const body = await request.json().catch(() => ({}));
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const flowRateLitersPerMinute = Number(body.flowRateLitersPerMinute ?? 10);
  const tankAvailableLiters = Number(body.tankAvailableLiters);
  const tankReserveLiters = Number(body.tankReserveLiters ?? 0);
  const waterSavingPercent = Number(body.waterSavingPercent ?? 70);
  const irrigationMode = String(body.irrigationMode ?? "medium_productivity");

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data: land, error: landError } = await supabase
      .from("lands")
      .select("id,name,crop_hint,area_m2")
      .eq("id", landId)
      .single();

    if (landError) throw landError;

    const { data: imageryRows, error: imageryError } = await supabase
      .from("imagery")
      .select("id,image_url,metadata,source,captured_at,created_at")
      .eq("land_id", landId)
      .order("created_at", { ascending: false });

    if (imageryError) throw imageryError;

    const uniqueImages = uniqueImagery(imageryRows ?? []);
    if (!uniqueImages.length) {
      return NextResponse.json({
        analyzed: 0,
        skippedExisting: 0,
        skippedDuplicates: 0,
        message: "No saved imagery found for this land"
      });
    }

    const sensorContext = await getLatestSensorContext(supabase, landId);
    const weather = await getWeather(lat, lon);
    const newAnalyses: any[] = [];
    let skippedExisting = 0;

    for (const image of uniqueImages) {
      const { data: existingAnalysis, error: existingError } = await supabase
        .from("ai_analyses")
        .select("id")
        .eq("land_id", landId)
        .eq("imagery_id", image.id)
        .maybeSingle();

      if (existingError) throw existingError;
      if (existingAnalysis) {
        skippedExisting += 1;
        continue;
      }

      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from("imagery")
        .download(image.image_url);

      if (downloadError) throw downloadError;

      const bytes = Buffer.from(await fileBlob.arrayBuffer());
      const mimeType = image.metadata?.mimeType || "image/jpeg";
      const analysis = await analyzeAgricultureImage({
        imageBase64: bytes.toString("base64"),
        mimeType,
        land: {
          id: land.id,
          name: land.name,
          cropHint: land.crop_hint,
          areaM2: Number(land.area_m2 ?? 0)
        },
        weather,
        sensorContext
      });

      const { data: aiRow, error: aiError } = await supabase
        .from("ai_analyses")
        .insert({
          land_id: landId,
          imagery_id: image.id,
          model_name: "gemini-2.5-flash",
          plant_summary: { plants: analysis.plants ?? [] },
          pest_summary: analysis.pests ?? {},
          weather_snapshot: { ...weather, sensorContext },
          raw_ai_json: analysis,
          confidence: Number(analysis.overall_confidence ?? 0)
        })
        .select("id,plant_summary,pest_summary,confidence,created_at")
        .single();

      if (aiError) throw aiError;
      newAnalyses.push(aiRow);
    }

    const { data: allAnalyses, error: allAnalysesError } = await supabase
      .from("ai_analyses")
      .select("id,plant_summary,pest_summary,confidence,created_at")
      .eq("land_id", landId)
      .order("created_at", { ascending: false });

    if (allAnalysesError) throw allAnalysesError;

    const { data: verifiedPlants, error: verifiedPlantsError } = await supabase
      .from("land_plants")
      .select("id,name,count,growth_stage,notes,source")
      .eq("land_id", landId);

    if (verifiedPlantsError) throw verifiedPlantsError;

    const plants = verifiedPlants?.length ? manualPlants(verifiedPlants) : aggregatePlants(allAnalyses ?? []);
    const irrigation = calculateIrrigation({
      plants,
      areaM2: Number(land.area_m2 ?? 0),
      forecastRainMm: weather.forecastRainMm,
      flowRateLitersPerMinute,
      tankAvailableLiters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : undefined,
      tankReserveLiters: Number.isFinite(tankReserveLiters) ? tankReserveLiters : undefined,
      waterSavingPercent: Number.isFinite(waterSavingPercent) ? waterSavingPercent : undefined,
      irrigationMode,
      agronomicContext: weather.agronomic,
      sensorContext
    });

    let recommendationId: number | null = null;
    if (plants.length) {
      const { data: recRow, error: recError } = await supabase
        .from("irrigation_recommendations")
        .insert({
          land_id: landId,
          ai_analysis_id: newAnalyses[0]?.id ?? null,
          total_liters_per_day: irrigation.totalLitersPerDay,
          rain_deduction_liters: irrigation.rainDeductionLiters,
          recommended_duration_seconds: irrigation.recommendedIrrigationDurationSeconds,
          flow_rate_liters_per_minute: flowRateLitersPerMinute,
          reason: verifiedPlants?.length
            ? `Generated from admin verified manual plant inventory plus latest ESP32 soil moisture when available. Soil moisture ${irrigation.soilMoisturePercent ?? "n/a"}%; moisture factor ${irrigation.soilMoistureAdjustmentFactor.toFixed(2)}; moisture deduction ${irrigation.soilMoistureDeductionLiters.toFixed(1)} L. Raw one irrigation ${irrigation.rawTotalLitersPerIrrigation.toFixed(1)} L; irrigation mode ${irrigation.irrigationModeLabel} (${irrigation.waterSavingPercent.toFixed(0)}% of full target); planned daily average ${irrigation.totalLitersPerDay.toFixed(1)} L; one irrigation ${irrigation.totalLitersPerIrrigation.toFixed(1)} L every ${irrigation.irrigationIntervalDays} day(s). Tank executable ${irrigation.executableLiters.toFixed(1)} L; shortage ${irrigation.tankShortageLiters.toFixed(1)} L.`
            : `Generated from all saved unique imagery for this land plus latest ESP32 soil moisture when available. Soil moisture ${irrigation.soilMoisturePercent ?? "n/a"}%; moisture factor ${irrigation.soilMoistureAdjustmentFactor.toFixed(2)}; moisture deduction ${irrigation.soilMoistureDeductionLiters.toFixed(1)} L. Raw one irrigation ${irrigation.rawTotalLitersPerIrrigation.toFixed(1)} L; irrigation mode ${irrigation.irrigationModeLabel} (${irrigation.waterSavingPercent.toFixed(0)}% of full target); planned daily average ${irrigation.totalLitersPerDay.toFixed(1)} L; one irrigation ${irrigation.totalLitersPerIrrigation.toFixed(1)} L every ${irrigation.irrigationIntervalDays} day(s). Tank executable ${irrigation.executableLiters.toFixed(1)} L; shortage ${irrigation.tankShortageLiters.toFixed(1)} L.`,
          status: "pending"
        })
        .select("id")
        .single();

      if (recError) throw recError;
      recommendationId = recRow.id;
    }

    return NextResponse.json({
      analyzed: newAnalyses.length,
      skippedExisting,
      skippedDuplicates: Math.max(0, (imageryRows?.length ?? 0) - uniqueImages.length),
      uniqueImages: uniqueImages.length,
      totalImages: imageryRows?.length ?? 0,
      aggregatePlants: plants,
      sensorContext,
      irrigation,
      recommendationId
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Saved imagery analysis failed" },
      { status: 500 }
    );
  }
}
