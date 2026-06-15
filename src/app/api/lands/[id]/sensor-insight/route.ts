import { NextRequest, NextResponse } from "next/server";
import { generateSensorInsight } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const body = await request.json().catch(() => ({}));

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [landResult, telemetryResult, recommendationsResult, analysesResult] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,centroid,created_at")
        .eq("id", landId)
        .single(),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,flow_liters_per_minute,valve_state,battery_percent,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(24),
      supabase
        .from("irrigation_recommendations")
        .select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("ai_analyses")
        .select("id,plant_summary,pest_summary,confidence,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5)
    ]);

    if (landResult.error) throw landResult.error;
    if (recommendationsResult.error) throw recommendationsResult.error;
    if (analysesResult.error) throw analysesResult.error;

    const centroid = landResult.data?.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0] ?? Number(body.lon);
    const lat = centroid?.coordinates?.[1] ?? Number(body.lat);
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(lat, lon)
      : null;

    const telemetry = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    const insight = await generateSensorInsight({
      land: landResult.data,
      telemetry,
      recommendations: recommendationsResult.data ?? [],
      analyses: analysesResult.data ?? [],
      weather
    });

    return NextResponse.json({
      insight,
      telemetryAvailable: !telemetryResult.error,
      telemetryError: telemetryResult.error ? telemetryResult.error.message : null,
      telemetryCount: telemetry.length,
      weather
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sensor insight failed" },
      { status: 500 }
    );
  }
}
