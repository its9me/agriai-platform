import { NextRequest, NextResponse } from "next/server";
import { generateUnifiedDecision } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function pestRiskValue(risk: unknown) {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function buildFallbackDecision(landOps: {
  land: { name?: string; auto_irrigation_enabled?: boolean };
  analyses: any[];
  recommendations: any[];
  commands: any[];
  devices: any[];
  telemetry: any[];
  imagery: any[];
  fieldNotes: any[];
  actionPlans: any[];
}, evidenceCounts: Record<string, number>, optionalErrors: (string | null)[]) {
  const latestAnalysis = landOps.analyses[0];
  const latestRecommendation = landOps.recommendations[0];
  const latestRisk = latestAnalysis?.pest_summary?.risk_level;
  const activeDevices = landOps.devices.filter((device) => device.is_active).length;
  const hasActiveDevice = activeDevices > 0;
  const hasTelemetry = landOps.telemetry.length > 0;
  const hasImages = landOps.imagery.length > 0 || landOps.analyses.length > 0;
  const riskScore = pestRiskValue(latestRisk);
  const durationSeconds = Number(latestRecommendation?.recommended_duration_seconds ?? 0);

  const decision = !hasImages
    ? "collect_images"
    : riskScore >= 3
      ? "inspect_pest"
      : !hasActiveDevice
        ? "connect_iot"
        : latestRecommendation && durationSeconds > 0
          ? "manual_review"
          : "wait";

  const riskLevel = riskScore >= 3
    ? "high"
    : (!hasImages || !hasActiveDevice || !hasTelemetry)
      ? "medium"
      : "low";

  const missingData = [
    !hasImages ? "صور أو تحليل AI حديث" : null,
    !hasActiveDevice ? "جهاز ESP32 فعّال" : null,
    !hasTelemetry ? "قراءات حساسات للتربة" : null,
    !latestRecommendation ? "توصية ري حديثة" : null,
    ...optionalErrors.filter(Boolean)
  ].filter(Boolean) as string[];

  return {
    headline: `قرار تشغيلي احتياطي لأرض ${landOps.land.name ?? "غير مسماة"}`,
    decision,
    confidence: Math.max(0.35, Math.min(0.82, 0.35 + evidenceCounts.analyses * 0.08 + evidenceCounts.recommendations * 0.06 + evidenceCounts.imagery * 0.03 + evidenceCounts.telemetry * 0.04)),
    risk_level: riskLevel,
    why: "تم توليد هذا القرار من سجلات Supabase الفعلية لأن Gemini غير متاح حالياً أو وصلت الحصة المجانية. القرار لا يستخدم بيانات مفترضة.",
    evidence_used: [
      { source: "image_ai", finding: `${evidenceCounts.analyses} تحليل AI محفوظ، خطر الآفات الأخير: ${latestRisk ?? "unknown"}`, strength: evidenceCounts.analyses ? "medium" : "weak" },
      { source: "imagery", finding: `${evidenceCounts.imagery} صورة محفوظة مرتبطة بالأرض`, strength: evidenceCounts.imagery ? "medium" : "weak" },
      { source: "recommendation", finding: latestRecommendation ? `${Number(latestRecommendation.total_liters_per_day ?? 0).toFixed(1)} لتر/يوم، مدة ${durationSeconds} ثانية` : "لا توجد توصية ري محفوظة", strength: latestRecommendation ? "medium" : "weak" },
      { source: "sensor", finding: hasTelemetry ? `${evidenceCounts.telemetry} قراءة حساسات متاحة` : "لا توجد قراءات حساسات متاحة", strength: hasTelemetry ? "medium" : "weak" },
      { source: "iot_command", finding: `${evidenceCounts.commands} أوامر IoT محفوظة و ${activeDevices} جهاز فعّال`, strength: hasActiveDevice ? "medium" : "weak" }
    ],
    farmer_next_actions: [
      {
        title: decision === "inspect_pest" ? "فحص الآفات قبل الري" : decision === "collect_images" ? "التقاط صور جديدة" : decision === "connect_iot" ? "ربط جهاز التحكم" : "مراجعة القرار قبل التنفيذ",
        priority: riskLevel === "high" ? "high" : "medium",
        time_window: "اليوم",
        success_check: missingData.length ? `إكمال: ${missingData.slice(0, 3).join("، ")}` : "توثيق نتيجة التنفيذ في سجل الأرض"
      }
    ],
    automation: {
      allowed: Boolean(hasActiveDevice && latestRecommendation && durationSeconds > 0 && riskScore < 3 && hasTelemetry),
      reason: hasActiveDevice && latestRecommendation && durationSeconds > 0 && riskScore < 3 && hasTelemetry
        ? "الأتمتة ممكنة بعد موافقة المشغل لأن الجهاز والتوصية والحساسات متاحة."
        : "الأتمتة موقوفة لأن الدليل غير مكتمل أو خطر الآفات/الأجهزة يحتاج مراجعة.",
      suggested_duration_seconds: hasActiveDevice && riskScore < 3 ? Math.max(0, durationSeconds) : 0,
      requires_human_approval: true
    },
    manager_view: {
      judge_story: "المنصة لا تتوقف عند نفاد حصة Gemini، بل تنتقل إلى قرار تشغيلي شفاف مبني على الأدلة المخزنة.",
      business_value: "هذا يقلل مخاطر العرض ويثبت أن النظام قابل للتشغيل اليومي حتى عند تعطل خدمة AI خارجية.",
      weakest_link: missingData[0] ?? "تحتاج أرشفة قرارات وتنفيذ ميداني أكثر"
    },
    missing_data: missingData
  };
}

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
      analysesResult,
      recommendationsResult,
      commandsResult,
      devicesResult,
      telemetryResult,
      imageryResult,
      notesResult,
      plansResult
    ] = await Promise.all([
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
        .from("iot_commands")
        .select("id,status,payload,published_at,acknowledged_at,ack_payload,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("iot_devices")
        .select("id,device_uid,is_active,last_seen_at")
        .eq("land_id", landId),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,flow_liters_per_minute,valve_state,battery_percent,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(12),
      supabase
        .from("imagery")
        .select("id,image_url,source,captured_at,created_at,metadata")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(6),
      supabase
        .from("field_notes")
        .select("id,note,triage_json,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("ai_action_plans")
        .select("id,plan_json,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5)
    ]);

    for (const result of [landResult, analysesResult, recommendationsResult, commandsResult, devicesResult]) {
      if (result.error) throw result.error;
    }

    const centroid = landResult.data?.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0] ?? Number(body.lon);
    const lat = centroid?.coordinates?.[1] ?? Number(body.lat);
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(lat, lon)
      : null;

    const telemetryError = telemetryResult.error ? telemetryResult.error.message : null;
    const optionalErrors = [
      imageryResult.error ? `imagery: ${imageryResult.error.message}` : null,
      notesResult.error ? `field_notes: ${notesResult.error.message}` : null,
      plansResult.error ? `ai_action_plans: ${plansResult.error.message}` : null,
      telemetryError ? `iot_telemetry: ${telemetryError}` : null
    ].filter(Boolean);

    const landOps = {
      land: landResult.data ?? {},
      analyses: analysesResult.data ?? [],
      recommendations: recommendationsResult.data ?? [],
      commands: commandsResult.data ?? [],
      devices: devicesResult.data ?? [],
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      imagery: imageryResult.error ? [] : (imageryResult.data ?? []),
      fieldNotes: notesResult.error ? [] : (notesResult.data ?? []),
      actionPlans: plansResult.error ? [] : (plansResult.data ?? [])
    };

    const evidenceCounts = {
      analyses: landOps.analyses.length,
      recommendations: landOps.recommendations.length,
      commands: landOps.commands.length,
      devices: landOps.devices.length,
      telemetry: landOps.telemetry.length,
      imagery: landOps.imagery.length,
      fieldNotes: landOps.fieldNotes.length,
      actionPlans: landOps.actionPlans.length
    };

    let decisionSource = "gemini";
    let aiError: string | null = null;
    let decision;

    try {
      decision = await generateUnifiedDecision({
        landOps,
        weather,
        place: body.place ?? null,
        projectContext: {
          optionalDataErrors: optionalErrors,
          hasMqttConfiguration: Boolean(process.env.MQTT_BROKER_URL && process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD),
          uiIntent: "single defensible field decision for farmer, operator, and judges"
        }
      });
    } catch (error) {
      decisionSource = "rules_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      decision = buildFallbackDecision(landOps, evidenceCounts, optionalErrors);
    }

    const { data: savedDecision, error: saveError } = await supabase
      .from("ai_decisions")
      .insert({
        land_id: landId,
        decision_json: decision,
        evidence_counts: evidenceCounts,
        weather_snapshot: weather,
        status: "generated"
      })
      .select("id")
      .single();

    return NextResponse.json({
      decision,
      decisionSource,
      aiError,
      weather,
      evidenceCounts,
      saved: saveError ? null : { decisionId: savedDecision?.id ?? null },
      saveError: saveError
        ? "شغّل outputs/ai_decisions_schema.sql في Supabase SQL Editor حتى يتم حفظ قرارات AI كسجل تدقيق."
        : null,
      optionalErrors
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unified decision failed" },
      { status: 500 }
    );
  }
}
