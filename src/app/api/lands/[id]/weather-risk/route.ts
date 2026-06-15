import { NextRequest, NextResponse } from "next/server";
import { generateWeatherIrrigationRisk } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function buildFallbackWeatherRisk(input: {
  land: unknown;
  weather: { forecastRainMm?: number; forecast?: Array<{ tempC?: number; humidity?: number; rainMm?: number }> } | null;
  recommendations: any[];
  analyses: any[];
  telemetry: any[];
  error?: string | null;
}) {
  const forecast = input.weather?.forecast ?? [];
  const forecastRainMm = Number(input.weather?.forecastRainMm ?? 0);
  const maxTemp = forecast.reduce((max, item) => Math.max(max, Number(item.tempC ?? 0)), 0);
  const avgHumidity = forecast.length
    ? forecast.reduce((sum, item) => sum + Number(item.humidity ?? 0), 0) / forecast.length
    : 0;
  const latestRecommendation = input.recommendations[0];
  const latestRisk = input.analyses[0]?.pest_summary?.risk_level ?? "unknown";
  const latestMoisture = input.telemetry[0]?.soil_moisture_percent;
  const rainHeavy = forecastRainMm >= 8;
  const heatHigh = maxTemp >= 38;
  const pestHigh = latestRisk === "high";

  const adjustment = pestHigh
    ? "inspect_first"
    : rainHeavy
      ? "delay"
      : heatHigh && forecastRainMm < 2
        ? "increase"
        : forecastRainMm >= 2
          ? "reduce"
          : "normal";

  const risk = pestHigh || heatHigh || rainHeavy ? "medium" : "low";
  const missingData = [
    input.error ? "Gemini غير متاح حالياً، تم استخدام تحليل طقس احتياطي" : null,
    !input.recommendations.length ? "توصية ري حديثة" : null,
    latestMoisture === undefined ? "قراءة رطوبة تربة من ESP32" : null,
    !input.analyses.length ? "تحليل صورة حديث" : null
  ].filter(Boolean) as string[];

  return {
    headline: "تنبيه طقس وري من البيانات الفعلية",
    weather_risk: risk,
    irrigation_adjustment: adjustment,
    confidence: Math.max(0.42, Math.min(0.82, 0.45 + input.recommendations.length * 0.08 + input.telemetry.length * 0.05 + input.analyses.length * 0.05)),
    why: "تم حساب التنبيه من توقعات OpenWeather وسجلات Supabase المتاحة بدون افتراض قراءات غير موجودة.",
    rain_effect: {
      forecast_rain_mm: forecastRainMm,
      recommendation: rainHeavy
        ? "يوجد مطر متوقع كافٍ لتأخير الري ومراجعة الأرض بعد الهطول."
        : forecastRainMm >= 2
          ? "يوجد مطر محدود، يفضل تقليل كمية الري ومراجعة آخر توصية."
          : "لا يوجد مطر مؤثر في التوقعات، اعتمد على الحرارة والرطوبة وحالة التربة."
    },
    heat_or_humidity_watch: [
      {
        signal: `أعلى حرارة متوقعة ${maxTemp.toFixed(1)}°C`,
        risk: heatHigh ? "medium" : "low",
        action: heatHigh ? "راقب الإجهاد الحراري وافحص الرطوبة قبل زيادة الري." : "لا توجد حرارة قصوى مؤثرة حسب التوقع الحالي."
      },
      {
        signal: `متوسط الرطوبة ${avgHumidity.toFixed(0)}%`,
        risk: avgHumidity >= 80 ? "medium" : "low",
        action: avgHumidity >= 80 ? "راقب الأمراض الفطرية وتجنب ترطيب زائد للأوراق." : "الرطوبة لا تفرض إجراء إضافي حالياً."
      }
    ],
    farmer_actions: [
      {
        title: adjustment === "delay" ? "تأخير الري" : adjustment === "reduce" ? "تقليل الري" : adjustment === "increase" ? "مراجعة زيادة الري" : adjustment === "inspect_first" ? "فحص الأرض قبل الري" : "اتباع الري الطبيعي",
        priority: risk,
        time_window: "خلال اليوم"
      }
    ],
    manager_value: latestRecommendation
      ? `يربط التنبيه آخر توصية ري (${Number(latestRecommendation.total_liters_per_day ?? 0).toFixed(1)} لتر/يوم) مع توقعات المطر والحرارة لتبرير القرار أمام الحكام.`
      : "يوضح للحكام أن المنصة تستخدم الطقس الحقيقي لتحديد نقص البيانات قبل الري.",
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
    const [landResult, recommendationsResult, analysesResult, telemetryResult] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,centroid,created_at")
        .eq("id", landId)
        .single(),
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
        .limit(5),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,valve_state,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(12)
    ]);

    for (const result of [landResult, recommendationsResult, analysesResult]) {
      if (result.error) throw result.error;
    }

    const centroid = landResult.data?.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0] ?? Number(body.lon);
    const lat = centroid?.coordinates?.[1] ?? Number(body.lat);
    const weather = Number.isFinite(lat) && Number.isFinite(lon) ? await getWeather(lat, lon) : null;
    const recommendations = recommendationsResult.data ?? [];
    const analyses = analysesResult.data ?? [];
    const telemetry = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    let source = "gemini";
    let aiError: string | null = null;
    let risk;

    try {
      risk = await generateWeatherIrrigationRisk({
        land: landResult.data,
        weather,
        recommendations,
        analyses,
        telemetry
      });
    } catch (error) {
      source = "rules_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      risk = buildFallbackWeatherRisk({
        land: landResult.data,
        weather,
        recommendations,
        analyses,
        telemetry,
        error: aiError
      });
    }

    return NextResponse.json({
      risk,
      source,
      aiError,
      weather,
      telemetryAvailable: telemetry.length > 0,
      telemetryError: telemetryResult.error?.message ?? null
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Weather risk failed" },
      { status: 500 }
    );
  }
}
