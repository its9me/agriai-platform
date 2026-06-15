import { NextResponse } from "next/server";
import { generateJudgeReport } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export async function POST() {
  try {
    const supabase = createSupabaseAdmin();
    const [landsResult, analysesResult, recommendationsResult, devicesResult] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,auto_irrigation_enabled,created_at"),
      supabase.from("ai_analyses").select("id,land_id,pest_summary,confidence,created_at").order("created_at", { ascending: false }).limit(10),
      supabase.from("irrigation_recommendations").select("id,land_id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("iot_devices").select("id,land_id,is_active,last_seen_at")
    ]);

    for (const result of [landsResult, analysesResult, recommendationsResult, devicesResult]) {
      if (result.error) throw result.error;
    }

    const lands = landsResult.data ?? [];
    const analyses = analysesResult.data ?? [];
    const recommendations = recommendationsResult.data ?? [];
    const devices = devicesResult.data ?? [];
    const dashboard = {
      totals: {
        lands: lands.length,
        areaM2: lands.reduce((sum, land) => sum + Number(land.area_m2 ?? 0), 0),
        analyses: analyses.length,
        recommendations: recommendations.length,
        activeDevices: devices.filter((device) => device.is_active).length,
        autoIrrigationLands: lands.filter((land) => land.auto_irrigation_enabled).length,
        latestRecommendedLiters: recommendations[0]?.total_liters_per_day ?? 0
      },
      recent: {
        lands,
        analyses,
        recommendations
      }
    };

    const report = await generateJudgeReport({
      dashboard,
      capabilities: [
        "تحديد الأرض من خريطة قمر صناعي وطرق وأراضي زراعية",
        "حفظ الأراضي في Supabase/PostGIS",
        "جلب الطقس الحقيقي من OpenWeather",
        "تحليل صور الهاتف أو الدرون باستخدام Gemini",
        "مستشار AI للأرض والطقس",
        "خطة تنفيذ AI لمدة 7 أيام",
        "لوحة مدير مشروع ومركز عمليات لكل أرض",
        "بنية MQTT جاهزة للربط مع ESP32"
      ],
      missingIntegrations: [
        "بيانات MQTT الفعلية غير مضافة بعد",
        "حساسات رطوبة التربة غير مربوطة بعد",
        "صور الدرون تحفظ حالياً كنتيجة تحليل ولا يوجد أرشيف صور كامل بعد"
      ]
    });

    return NextResponse.json({ report, dashboard });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Judge report failed" },
      { status: 500 }
    );
  }
}
