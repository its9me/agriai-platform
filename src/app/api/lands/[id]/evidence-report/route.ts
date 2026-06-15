import { NextRequest, NextResponse } from "next/server";
import { generateLandEvidenceReport } from "@/lib/gemini";
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
    const [
      landResult,
      imageryResult,
      analysesResult,
      recommendationsResult,
      commandsResult,
      devicesResult,
      telemetryResult,
      notesResult,
      plansResult
    ] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,boundary_geojson,centroid,created_at")
        .eq("id", landId)
        .single(),
      supabase
        .from("imagery")
        .select("id,image_url,source,captured_at,metadata,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("ai_analyses")
        .select("id,plant_summary,pest_summary,confidence,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("irrigation_recommendations")
        .select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("iot_commands")
        .select("id,status,payload,published_at,acknowledged_at,ack_payload,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("iot_devices")
        .select("id,device_uid,is_active,last_seen_at")
        .eq("land_id", landId),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,flow_liters_per_minute,valve_state,battery_percent,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(24),
      supabase
        .from("field_notes")
        .select("id,note,triage_json,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("ai_action_plans")
        .select("id,plan_json,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8)
    ]);

    for (const result of [landResult, imageryResult, analysesResult, recommendationsResult, commandsResult, devicesResult]) {
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
      imagery: imageryResult.data ?? [],
      analyses: analysesResult.data ?? [],
      recommendations: recommendationsResult.data ?? [],
      commands: commandsResult.data ?? [],
      devices: devicesResult.data ?? [],
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      fieldNotes: notesResult.error ? [] : (notesResult.data ?? []),
      actionPlans: plansResult.error ? [] : (plansResult.data ?? [])
    };

    const report = await generateLandEvidenceReport({ landOps, weather });

    return NextResponse.json({
      report,
      evidenceCounts: {
        imagery: landOps.imagery.length,
        analyses: landOps.analyses.length,
        recommendations: landOps.recommendations.length,
        commands: landOps.commands.length,
        devices: landOps.devices.length,
        telemetry: landOps.telemetry.length,
        fieldNotes: landOps.fieldNotes.length,
        actionPlans: landOps.actionPlans.length
      },
      weather
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Evidence report failed" },
      { status: 500 }
    );
  }
}
