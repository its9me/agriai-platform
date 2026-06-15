import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function maturityScore(input: {
  hasLand: boolean;
  hasAnalysis: boolean;
  hasRecommendation: boolean;
  hasFieldNotes: boolean;
  hasActionPlan: boolean;
  hasDevice: boolean;
}) {
  return [
    input.hasLand,
    input.hasAnalysis,
    input.hasRecommendation,
    input.hasFieldNotes,
    input.hasActionPlan,
    input.hasDevice
  ].filter(Boolean).length;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [landResult, analysesResult, recommendationsResult, devicesResult, notesResult, plansResult] = await Promise.all([
      supabase.from("lands").select("id,name,area_m2,auto_irrigation_enabled").eq("id", landId).single(),
      supabase.from("ai_analyses").select("id,pest_summary,created_at").eq("land_id", landId),
      supabase.from("irrigation_recommendations").select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at").eq("land_id", landId),
      supabase.from("iot_devices").select("id,is_active").eq("land_id", landId),
      supabase.from("field_notes").select("id,created_at").eq("land_id", landId),
      supabase.from("ai_action_plans").select("id,status,created_at").eq("land_id", landId)
    ]);

    if (landResult.error) throw landResult.error;
    if (analysesResult.error) throw analysesResult.error;
    if (recommendationsResult.error) throw recommendationsResult.error;
    if (devicesResult.error) throw devicesResult.error;

    const analyses = analysesResult.data ?? [];
    const recommendations = recommendationsResult.data ?? [];
    const devices = devicesResult.data ?? [];
    const notes = notesResult.error ? [] : (notesResult.data ?? []);
    const plans = plansResult.error ? [] : (plansResult.data ?? []);
    const latestRecommendation = recommendations
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    const totalRainDeduction = recommendations.reduce((sum, rec) => {
      return sum + Number(rec.rain_deduction_liters ?? 0);
    }, 0);

    const activeDevices = devices.filter((device) => device.is_active).length;
    const score = maturityScore({
      hasLand: Boolean(landResult.data),
      hasAnalysis: analyses.length > 0,
      hasRecommendation: recommendations.length > 0,
      hasFieldNotes: notes.length > 0,
      hasActionPlan: plans.length > 0,
      hasDevice: activeDevices > 0
    });

    return NextResponse.json({
      land: landResult.data,
      impact: {
        maturityScore: score,
        maturityMax: 6,
        maturityLabel: score >= 5 ? "تشغيل متقدم" : score >= 3 ? "تشغيل متوسط" : "بداية تشغيل",
        measuredWaterSavingLiters: totalRainDeduction,
        latestRecommendedLiters: latestRecommendation?.total_liters_per_day ?? 0,
        latestRecommendedDurationSeconds: latestRecommendation?.recommended_duration_seconds ?? 0,
        analysisCoverage: analyses.length,
        fieldObservationCoverage: notes.length,
        actionPlanCoverage: plans.length,
        automationCoverage: activeDevices,
        story: recommendations.length
          ? "توجد توصيات ري محفوظة يمكن استخدامها لإثبات انتقال المنصة من الملاحظة إلى قرار قابل للتنفيذ."
          : "لم يتم إنشاء توصيات ري بعد؛ أول تحليل صورة سيحوّل الأرض إلى سجل قرارات قابل للقياس."
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impact calculation failed" },
      { status: 500 }
    );
  }
}
