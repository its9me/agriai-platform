import { NextResponse } from "next/server";
import { generateDemoReadinessReport } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

const configChecks = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
  "OPENWEATHER_API_KEY",
  "MQTT_BROKER_URL",
  "MQTT_USERNAME",
  "MQTT_PASSWORD"
];

export async function POST() {
  try {
    const configuration = Object.fromEntries(
      configChecks.map((name) => [name, Boolean(process.env[name])])
    );
    const missingIntegrations = Object.entries(configuration)
      .filter(([, ready]) => !ready)
      .map(([name]) => name);

    const supabase = createSupabaseAdmin();
    const [
      landsResult,
      imageryResult,
      analysesResult,
      recommendationsResult,
      devicesResult,
      commandsResult,
      telemetryResult,
      notesResult,
      plansResult
    ] = await Promise.all([
      supabase.from("lands").select("id,area_m2,auto_irrigation_enabled"),
      supabase.from("imagery").select("id,land_id"),
      supabase.from("ai_analyses").select("id,land_id,pest_summary,confidence"),
      supabase.from("irrigation_recommendations").select("id,land_id,status,total_liters_per_day,rain_deduction_liters"),
      supabase.from("iot_devices").select("id,land_id,is_active,last_seen_at"),
      supabase.from("iot_commands").select("id,land_id,status,acknowledged_at"),
      supabase.from("iot_telemetry").select("id,land_id"),
      supabase.from("field_notes").select("id,land_id"),
      supabase.from("ai_action_plans").select("id,land_id,status")
    ]);

    for (const result of [landsResult, imageryResult, analysesResult, recommendationsResult, devicesResult, commandsResult]) {
      if (result.error) throw result.error;
    }

    const lands = landsResult.data ?? [];
    const imagery = imageryResult.data ?? [];
    const analyses = analysesResult.data ?? [];
    const recommendations = recommendationsResult.data ?? [];
    const devices = devicesResult.data ?? [];
    const commands = commandsResult.data ?? [];
    const telemetry = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    const notes = notesResult.error ? [] : (notesResult.data ?? []);
    const plans = plansResult.error ? [] : (plansResult.data ?? []);

    const metrics = {
      lands: lands.length,
      totalAreaM2: lands.reduce((sum, land) => sum + Number(land.area_m2 ?? 0), 0),
      autoIrrigationLands: lands.filter((land) => land.auto_irrigation_enabled).length,
      imagery: imagery.length,
      analyses: analyses.length,
      recommendations: recommendations.length,
      activeDevices: devices.filter((device) => device.is_active).length,
      commands: commands.length,
      acknowledgedCommands: commands.filter((command) => command.acknowledged_at).length,
      telemetry: telemetry.length,
      fieldNotes: notes.length,
      actionPlans: plans.length
    };

    const evidence = {
      hasMappedLand: metrics.lands > 0,
      hasImageEvidence: metrics.imagery > 0,
      hasAiAnalysis: metrics.analyses > 0,
      hasWaterRecommendation: metrics.recommendations > 0,
      hasIotDevice: metrics.activeDevices > 0,
      hasExecutedCommand: metrics.acknowledgedCommands > 0,
      hasSensorTelemetry: metrics.telemetry > 0,
      hasFieldNotes: metrics.fieldNotes > 0,
      hasActionPlan: metrics.actionPlans > 0
    };

    const readiness = await generateDemoReadinessReport({
      configuration,
      metrics,
      evidence,
      missingIntegrations
    });

    return NextResponse.json({
      readiness,
      configuration,
      metrics,
      evidence,
      missingIntegrations
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Readiness report failed" },
      { status: 500 }
    );
  }
}
