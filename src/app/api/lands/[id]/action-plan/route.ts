import { NextRequest, NextResponse } from "next/server";
import { generateActionPlan } from "@/lib/gemini";
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
    const [landResult, analysesResult, recommendationsResult, devicesResult] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,centroid,created_at")
        .eq("id", landId)
        .single(),
      supabase
        .from("ai_analyses")
        .select("id,plant_summary,pest_summary,confidence,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("irrigation_recommendations")
        .select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("iot_devices")
        .select("id,device_uid,is_active,last_seen_at")
        .eq("land_id", landId)
    ]);

    for (const result of [landResult, analysesResult, recommendationsResult, devicesResult]) {
      if (result.error) throw result.error;
    }

    const centroid = landResult.data?.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0] ?? Number(body.lon);
    const lat = centroid?.coordinates?.[1] ?? Number(body.lat);
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(lat, lon)
      : null;

    const landOps = {
      land: landResult.data,
      analyses: analysesResult.data ?? [],
      recommendations: recommendationsResult.data ?? [],
      devices: devicesResult.data ?? []
    };

    const plan = await generateActionPlan({
      landOps,
      weather,
      place: body.place ?? null
    });

    let saved: null | { actionPlanId: number } = null;
    const { data: planRow, error: planError } = await supabase
      .from("ai_action_plans")
      .insert({
        land_id: landId,
        plan_json: plan,
        weather_snapshot: weather,
        status: "draft"
      })
      .select("id")
      .single();

    if (!planError && planRow) {
      saved = { actionPlanId: planRow.id };
    }

    return NextResponse.json({ plan, weather, saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action plan failed" },
      { status: 500 }
    );
  }
}
