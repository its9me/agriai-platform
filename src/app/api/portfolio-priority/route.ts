import { NextResponse } from "next/server";
import { generatePortfolioPriority } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

function riskValue(risk: unknown) {
  if (risk === "high") return 30;
  if (risk === "medium") return 18;
  if (risk === "low") return 8;
  return 0;
}

function buildFallbackPriority(portfolioState: {
  lands: any[];
  analyses: any[];
  recommendations: any[];
  devices: any[];
  telemetry: any[];
  fieldNotes: any[];
  actionPlans: any[];
  aiDecisions: any[];
  knownGaps: unknown[];
}) {
  const ranked = portfolioState.lands
    .map((land) => {
      const analyses = portfolioState.analyses.filter((item) => item.land_id === land.id);
      const recommendations = portfolioState.recommendations.filter((item) => item.land_id === land.id);
      const devices = portfolioState.devices.filter((item) => item.land_id === land.id);
      const telemetry = portfolioState.telemetry.filter((item) => item.land_id === land.id);
      const notes = portfolioState.fieldNotes.filter((item) => item.land_id === land.id);
      const plans = portfolioState.actionPlans.filter((item) => item.land_id === land.id);
      const latestRisk = analyses[0]?.pest_summary?.risk_level;
      let score = riskValue(latestRisk);

      if (!analyses.length) score += 22;
      if (!recommendations.length) score += 18;
      if (!devices.some((device) => device.is_active)) score += 14;
      if (!telemetry.length) score += 10;
      if (!plans.length) score += 7;
      if (notes.length) score += 6;

      const evidence = [
        analyses.length ? `${analyses.length} تحليل AI محفوظ` : "لا يوجد تحليل صور محفوظ",
        recommendations.length ? `${recommendations.length} توصية ري محفوظة` : "لا توجد توصية ري محفوظة",
        devices.length ? `${devices.length} جهاز IoT مسجل` : "لا يوجد جهاز IoT مسجل",
        telemetry.length ? `${telemetry.length} قراءة حساسات` : "لا توجد قراءات حساسات"
      ];

      const missingData = [
        !analyses.length ? "صور وتحليل AI" : null,
        !recommendations.length ? "توصية ري حديثة" : null,
        !devices.some((device) => device.is_active) ? "جهاز ESP32 فعّال" : null,
        !telemetry.length ? "قراءات رطوبة/حساسات" : null
      ].filter(Boolean) as string[];

      const recommendedAction = !analyses.length
        ? "collect_images"
        : latestRisk === "high"
          ? "inspect"
          : !devices.some((device) => device.is_active)
            ? "connect_iot"
            : recommendations.length
              ? "review_data"
              : "wait";

      return {
        land,
        score,
        latestRisk,
        evidence,
        missingData,
        recommendedAction
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((item, index) => ({
      rank: index + 1,
      land_id: item.land.id,
      land_name: item.land.name,
      priority: item.score >= 45 ? "high" : item.score >= 24 ? "medium" : "low",
      primary_reason: item.latestRisk
        ? `آخر خطر آفات مسجل: ${item.latestRisk}، مع درجة تشغيلية ${item.score}.`
        : `الأولوية مبنية على نقص الأدلة التشغيلية، مع درجة ${item.score}.`,
      recommended_action: item.recommendedAction,
      evidence: item.evidence,
      missing_data: item.missingData
    }));

  return {
    headline: "ترتيب أولويات الأراضي من البيانات الفعلية",
    portfolio_risk: ranked.some((item) => item.priority === "high") ? "high" : ranked.some((item) => item.priority === "medium") ? "medium" : "low",
    manager_summary: "تم استخدام ترتيب احتياطي مبني على سجلات Supabase لأن حصة Gemini المجانية غير متاحة حالياً. النتيجة تعتمد على الصور والتحليلات والتوصيات والأجهزة والحساسات المسجلة فقط.",
    ranked_lands: ranked,
    dispatch_plan: ranked.slice(0, 3).map((item) => ({
      owner: item.recommended_action === "connect_iot" ? "manager" : "operator",
      task: item.recommended_action === "collect_images"
        ? "التقاط صور هاتف أو درون ثم تشغيل التحليل"
        : item.recommended_action === "inspect"
          ? "فحص ميداني للآفات قبل أي ري تلقائي"
          : item.recommended_action === "connect_iot"
            ? "ربط ESP32 وتأكيد وصول أوامر MQTT"
            : "مراجعة آخر توصية ري والقرار الموحد",
      target_land: item.land_name,
      time_window: "خلال 24 ساعة",
      success_metric: item.missing_data.length ? `إكمال: ${item.missing_data.join("، ")}` : "تحديث سجل الأرض بدليل جديد"
    })),
    judge_value: "حتى عند نفاد حصة Gemini، تبقى المنصة قادرة على ترتيب العمل من الأدلة الحقيقية وتوضح بشفافية سبب كل أولوية.",
    system_gaps: [
      "حصة Gemini Free Tier غير متاحة حالياً لهذه العملية.",
      ...portfolioState.knownGaps.filter(Boolean).map(String)
    ]
  };
}

export async function POST() {
  try {
    const supabase = createSupabaseAdmin();
    const [
      landsResult,
      analysesResult,
      recommendationsResult,
      devicesResult,
      telemetryResult,
      notesResult,
      plansResult,
      decisionsResult
    ] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("ai_analyses")
        .select("id,land_id,plant_summary,pest_summary,confidence,created_at")
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("irrigation_recommendations")
        .select("id,land_id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at")
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("iot_devices")
        .select("id,land_id,device_uid,is_active,last_seen_at"),
      supabase
        .from("iot_telemetry")
        .select("id,land_id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,valve_state,captured_at,created_at")
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("field_notes")
        .select("id,land_id,note,triage_json,created_at")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("ai_action_plans")
        .select("id,land_id,plan_json,status,created_at")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("ai_decisions")
        .select("id,land_id,decision_json,evidence_counts,status,created_at")
        .order("created_at", { ascending: false })
        .limit(20)
    ]);

    for (const result of [landsResult, analysesResult, recommendationsResult, devicesResult]) {
      if (result.error) throw result.error;
    }

    const optionalErrors = [
      telemetryResult.error ? `iot_telemetry: ${telemetryResult.error.message}` : null,
      notesResult.error ? `field_notes: ${notesResult.error.message}` : null,
      plansResult.error ? `ai_action_plans: ${plansResult.error.message}` : null,
      decisionsResult.error ? `ai_decisions: ${decisionsResult.error.message}` : null
    ].filter(Boolean);

    const portfolioState = {
      generatedAt: new Date().toISOString(),
      lands: landsResult.data ?? [],
      analyses: analysesResult.data ?? [],
      recommendations: recommendationsResult.data ?? [],
      devices: devicesResult.data ?? [],
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      fieldNotes: notesResult.error ? [] : (notesResult.data ?? []),
      actionPlans: plansResult.error ? [] : (plansResult.data ?? []),
      aiDecisions: decisionsResult.error ? [] : (decisionsResult.data ?? []),
      knownGaps: [
        !process.env.MQTT_BROKER_URL ? "MQTT غير مفعّل بعد، لذلك أوامر الري قد لا تصل للـ ESP32." : null,
        telemetryResult.error ? "جدول أو قراءات iot_telemetry غير متاحة بالكامل." : null,
        decisionsResult.error ? "جدول ai_decisions غير مفعّل بعد، لذلك أرشفة القرارات غير مكتملة." : null
      ].filter(Boolean),
      optionalErrors
    };

    let prioritySource = "gemini";
    let priority;
    let aiError: string | null = null;

    try {
      priority = await generatePortfolioPriority({ portfolioState });
    } catch (error) {
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      prioritySource = "rules_fallback";
      priority = buildFallbackPriority(portfolioState);
    }

    return NextResponse.json({
      priority,
      prioritySource,
      aiError,
      portfolioState: {
        landsCount: portfolioState.lands.length,
        analysesCount: portfolioState.analyses.length,
        recommendationsCount: portfolioState.recommendations.length,
        devicesCount: portfolioState.devices.length,
        telemetryCount: portfolioState.telemetry.length,
        decisionsCount: portfolioState.aiDecisions.length
      },
      optionalErrors
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Portfolio priority failed" },
      { status: 500 }
    );
  }
}
