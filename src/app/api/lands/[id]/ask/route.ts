import { NextRequest, NextResponse } from "next/server";
import { answerLandQuestion } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function fallbackAnswer(question: string, landOps: any, weather: unknown, aiError: string | null) {
  const latestAnalysis = landOps.analyses[0];
  const latestRecommendation = landOps.recommendations[0];
  const latestDecision = landOps.decisions[0]?.decision_json;
  const latestRisk = latestAnalysis?.pest_summary?.risk_level ?? "unknown";
  const activeDevices = landOps.devices.filter((device: any) => device.is_active).length;
  const evidence = [
    latestDecision ? { source: "decision", detail: `آخر قرار: ${latestDecision.decision ?? "غير محدد"} / ${latestDecision.risk_level ?? "unknown"}` } : null,
    latestAnalysis ? { source: "image_ai", detail: `آخر خطر آفات: ${latestRisk} / ثقة ${Number(latestAnalysis.confidence ?? 0).toFixed(2)}` } : null,
    latestRecommendation ? { source: "recommendation", detail: `آخر ري: ${Number(latestRecommendation.total_liters_per_day ?? 0).toFixed(1)} لتر/يوم` } : null,
    { source: "iot", detail: `أجهزة فعالة: ${activeDevices}/${landOps.devices.length}` }
  ].filter((item): item is { source: string; detail: string } => Boolean(item));
  const missingData = [
    aiError ? "Gemini غير متاح حالياً" : null,
    !landOps.analyses.length ? "تحليل صورة حديث" : null,
    !landOps.telemetry.length ? "قراءات حساسات" : null,
    !landOps.decisions.length ? "قرار AI موحد محفوظ" : null
  ].filter((item): item is string => Boolean(item));

  return {
    answer: `لا أستطيع استخدام Gemini حالياً، لكن من بيانات الأرض الحالية: خطر الآفات الأخير ${latestRisk}، عدد التحليلات ${landOps.analyses.length}، توصيات الري ${landOps.recommendations.length}، والأجهزة الفعالة ${activeDevices}. سؤالك كان: "${question}".`,
    confidence: 0.45,
    evidence_used: evidence,
    recommended_next_step: latestDecision?.decision === "manual_review"
      ? "راجع سبب القرار الموحد واجمع صورة أو قراءة حساس إضافية قبل الأتمتة."
      : latestRecommendation
        ? "راجع آخر توصية ري وقرار السلامة قبل الإرسال للـ ESP32."
        : "ارفع صورة حديثة أو شغّل مستشار AI لتوليد توصية ري.",
    missing_data: missingData
  };
}

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

function aggregatePlantsByName(analyses: any[]) {
  const groups = new Map<string, {
    name: string;
    count: number;
    sightings: number;
    confidenceTotal: number;
    analysisIds: number[];
  }>();

  for (const analysis of analyses) {
    const plants = Array.isArray(analysis.plant_summary?.plants)
      ? analysis.plant_summary.plants
      : [];

    for (const plant of plants) {
      const name = String(plant.name ?? "unknown").trim();
      const key = name.toLowerCase();
      const count = Math.max(0, Number(plant.count ?? 0));
      const confidence = Math.max(0, Number(plant.count_confidence ?? 0));
      const current = groups.get(key) ?? {
        name,
        count: 0,
        sightings: 0,
        confidenceTotal: 0,
        analysisIds: []
      };

      current.count = Math.max(current.count, count);
      current.sightings += 1;
      current.confidenceTotal += confidence;
      current.analysisIds.push(Number(analysis.id));
      groups.set(key, current);
    }
  }

  return Array.from(groups.values()).map((plant) => ({
    name: plant.name,
    estimatedCount: plant.count,
    sightings: plant.sightings,
    averageConfidence: plant.sightings ? plant.confidenceTotal / plant.sightings : 0,
    analysisIds: Array.from(new Set(plant.analysisIds))
  }));
}

function manualPlantsToMemory(plants: any[]) {
  return plants.map((plant) => ({
    name: plant.name,
    estimatedCount: Number(plant.count ?? 0),
    sightings: 1,
    averageConfidence: 1,
    analysisIds: [],
    source: "manual",
    notes: plant.notes ?? ""
  }));
}

function isPlantCountQuestion(question: string) {
  const normalized = question.toLowerCase();
  return question.includes("كم")
    && (
      question.includes("نخلة")
      || question.includes("نخيل")
      || question.includes("شجرة")
      || question.includes("اشجار")
      || question.includes("أشجار")
      || normalized.includes("palm")
      || normalized.includes("plant")
      || normalized.includes("tree")
    );
}

function answerPlantCountFromMemory(question: string, landOps: any) {
  if (!isPlantCountQuestion(question)) return null;

  const memoryPlants = landOps.land_memory?.plants ?? [];
  const wantsPalm = question.includes("نخلة")
    || question.includes("نخيل")
    || question.toLowerCase().includes("palm");
  const selectedPlants = wantsPalm
    ? memoryPlants.filter((plant: any) => String(plant.name ?? "").toLowerCase().includes("palm"))
    : memoryPlants;
  const total = selectedPlants.reduce((sum: number, plant: any) => sum + Number(plant.estimatedCount ?? 0), 0);
  const confidenceValues = selectedPlants.map((plant: any) => Number(plant.averageConfidence ?? 0)).filter(Number.isFinite);
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum: number, value: number) => sum + value, 0) / confidenceValues.length
    : 0.55;

  const evidence = selectedPlants.map((plant: any) => ({
    source: plant.source === "manual" ? "land" : "image_ai",
    detail: plant.source === "manual"
      ? `${plant.name}: العدد المعتمد ${plant.estimatedCount} من الجرد اليدوي للمدير. ${plant.notes ? `ملاحظة: ${plant.notes}` : ""}`
      : `${plant.name}: العدد المعتمد ${plant.estimatedCount} بعد إزالة تكرار الصور والنباتات. ظهر هذا النوع في ${plant.sightings} تحليل. التحليلات المستخدمة: ${plant.analysisIds.join(", ")}.`
  }));

  return {
    answer: wantsPalm
      ? `حسب ذاكرة الأرض المجمّعة بعد إزالة تكرار الصور والنباتات، العدد المعتمد للنخيل في هذا الموقع هو ${total} نخلة.`
      : `حسب ذاكرة الأرض المجمّعة بعد إزالة التكرار، العدد التقديري للنباتات/الأشجار الظاهرة هو ${total}.`,
    confidence: Math.max(0.45, Math.min(0.92, confidence)),
    evidence_used: [
      {
        source: landOps.land_memory?.source === "manual" ? "land" : "image_ai",
        detail: landOps.land_memory?.source === "manual"
          ? "تم الاعتماد على الجرد اليدوي للنباتات لأنه مصدر تحقق أعلى من الصور."
          : `تم الاعتماد على ${landOps.land_memory?.uniqueImages ?? 0} صور فريدة و ${landOps.land_memory?.totalAnalyses ?? 0} تحليلات، وتم تجاهل ${landOps.land_memory?.duplicateImages ?? 0} صور مكررة.`
      },
      ...evidence
    ],
    recommended_next_step: "إذا تريد تثبيت العدد نهائياً، صوّر الأرض من زاوية واسعة واحدة تشمل كل النخيل أو أدخل عدد النخيل يدوياً من لوحة الإدارة كتحقق ميداني.",
    missing_data: total > 0 ? [] : ["لا توجد تحليلات صور كافية لتحديد العدد."]
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const body = await request.json().catch(() => ({}));
  const question = String(body.question ?? "").trim();

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
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
      plansResult,
      decisionsResult,
      plantsResult
    ] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,centroid,created_at").eq("id", landId).single(),
      supabase.from("ai_analyses").select("id,plant_summary,pest_summary,confidence,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(20),
      supabase.from("irrigation_recommendations").select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("iot_commands").select("id,status,payload,ack_payload,published_at,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("iot_devices").select("id,device_uid,is_active,last_seen_at").eq("land_id", landId),
      supabase.from("iot_telemetry").select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,valve_state,captured_at,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("imagery").select("id,image_url,source,captured_at,metadata,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(30),
      supabase.from("field_notes").select("id,note,triage_json,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("ai_action_plans").select("id,plan_json,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("ai_decisions").select("id,decision_json,evidence_counts,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("land_plants").select("id,name,count,growth_stage,notes,source,created_at,updated_at").eq("land_id", landId).order("created_at", { ascending: false })
    ]);

    if (landResult.error) throw landResult.error;

    const land = landResult.data;
    const centroid = land?.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0] ?? Number(body.lon);
    const lat = centroid?.coordinates?.[1] ?? Number(body.lat);
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(Number(lat), Number(lon)).catch(() => null)
      : null;
    const analyses = analysesResult.error ? [] : (analysesResult.data ?? []);
    const imagery = imageryResult.error ? [] : (imageryResult.data ?? []);
    const manualPlants = plantsResult.error ? [] : (plantsResult.data ?? []);
    const uniqueImages = uniqueImagery(imagery);
    const landMemory = {
      source: manualPlants.length ? "manual" : "image_ai",
      uniqueImages: uniqueImages.length,
      totalImageRecords: imagery.length,
      duplicateImages: Math.max(0, imagery.length - uniqueImages.length),
      totalAnalyses: analyses.length,
      plants: manualPlants.length ? manualPlantsToMemory(manualPlants) : aggregatePlantsByName(analyses)
    };

    const landOps = {
      land,
      land_memory: landMemory,
      analyses,
      recommendations: recommendationsResult.error ? [] : (recommendationsResult.data ?? []),
      commands: commandsResult.error ? [] : (commandsResult.data ?? []),
      devices: devicesResult.error ? [] : (devicesResult.data ?? []),
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      imagery: uniqueImages,
      notes: notesResult.error ? [] : (notesResult.data ?? []),
      plans: plansResult.error ? [] : (plansResult.data ?? []),
      decisions: decisionsResult.error ? [] : (decisionsResult.data ?? [])
    };

    let source = "gemini";
    let aiError: string | null = null;
    let answer = answerPlantCountFromMemory(question, landOps);

    if (!answer) {
      try {
        answer = await answerLandQuestion({ question, landOps, weather });
      } catch (error) {
        source = "rules_fallback";
        aiError = error instanceof Error ? error.message : "Gemini unavailable";
        answer = fallbackAnswer(question, landOps, weather, aiError);
      }
    } else {
      source = "land_memory";
    }

    return NextResponse.json({ answer, source, aiError });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Land question failed" },
      { status: 500 }
    );
  }
}
