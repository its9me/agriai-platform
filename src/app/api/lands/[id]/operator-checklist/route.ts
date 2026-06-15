import { NextRequest, NextResponse } from "next/server";
import { generateOperatorChecklist } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function normalizePriority(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["high", "عالية", "عالي", "مرتفع", "مرتفعة"].includes(text)) return "high";
  if (["low", "منخفضة", "منخفض", "واطئة", "واطي"].includes(text)) return "low";
  return "medium";
}

function normalizeChecklist(checklist: any) {
  return {
    ...checklist,
    overall_priority: normalizePriority(checklist?.overall_priority),
    checklist: Array.isArray(checklist?.checklist)
      ? checklist.checklist.map((item: any, index: number) => ({
        ...item,
        step: Number(item?.step ?? index + 1),
        owner: ["farmer", "operator", "manager"].includes(item?.owner) ? item.owner : "operator",
        priority: normalizePriority(item?.priority)
      }))
      : []
  };
}

function fallbackChecklist(landOps: {
  land: any;
  decisions: any[];
  plans: any[];
  recommendations: any[];
  devices: any[];
  telemetry: any[];
  analyses: any[];
  notes: any[];
}, aiError: string | null) {
  const latestDecision = landOps.decisions[0]?.decision_json;
  const latestPlan = landOps.plans[0]?.plan_json;
  const latestRecommendation = landOps.recommendations[0];
  const activeDevice = landOps.devices.some((device) => device.is_active);
  const latestRisk = landOps.analyses[0]?.pest_summary?.risk_level ?? "unknown";
  const checklist = [
    {
      step: 1,
      task: latestDecision?.decision === "inspect_pest" || latestRisk === "high"
        ? "افحص علامات الآفات قبل الري"
        : latestRecommendation
          ? "راجع آخر توصية ري قبل التنفيذ"
          : "شغّل تحليل صورة أو أنشئ توصية ري",
      owner: "operator",
      priority: latestRisk === "high" ? "high" : "medium",
      time_window: "اليوم",
      evidence: latestDecision?.headline ?? latestPlan?.plan_title ?? `آخر خطر آفات: ${latestRisk}`,
      done_when: "تم تسجيل نتيجة الفحص أو تنفيذ الخطوة في سجل الأرض"
    },
    {
      step: 2,
      task: activeDevice ? "تأكد من جاهزية ESP32 قبل إرسال أي أمر" : "اربط أو فعّل جهاز ESP32 لهذه الأرض",
      owner: "manager",
      priority: activeDevice ? "medium" : "high",
      time_window: "قبل أي ري تلقائي",
      evidence: activeDevice ? "يوجد جهاز فعّال مسجل" : "لا يوجد جهاز فعّال مسجل",
      done_when: activeDevice ? "آخر ظهور للجهاز مؤكد" : "يظهر الجهاز كفعّال في مركز العمليات"
    },
    {
      step: 3,
      task: landOps.telemetry.length ? "راجع قراءة الرطوبة الأخيرة" : "أرسل قراءة حساسات تجريبية من ESP32",
      owner: "operator",
      priority: landOps.telemetry.length ? "low" : "medium",
      time_window: "خلال 24 ساعة",
      evidence: landOps.telemetry.length ? `${landOps.telemetry.length} قراءة حساسات محفوظة` : "لا توجد قراءات حساسات",
      done_when: "تظهر قراءة حديثة في سجل ESP32"
    }
  ];

  return {
    title: `قائمة تشغيل أرض ${landOps.land?.name ?? "غير مسماة"}`,
    overall_priority: checklist.some((item) => item.priority === "high") ? "high" : "medium",
    operator_summary: "تم توليد هذه القائمة من سجلات Supabase الفعلية حتى يستطيع المشغل العمل بدون قراءة كل اللوحة.",
    checklist,
    do_not_do: [
      "لا ترسل أمر ري تلقائي إذا كان خطر الآفات عالي أو الجهاز غير مؤكد.",
      "لا تعتمد على قرار بدون صورة أو توصية ري حديثة عند توفرها."
    ],
    manager_note: aiError
      ? "تم استخدام fallback تشغيلي لأن Gemini غير متاح حالياً؛ القائمة ما زالت مبنية على بيانات المنصة."
      : "قائمة تشغيل قابلة للعرض أمام الحكام لأنها تربط القرار بخطوة تنفيذ واضحة.",
    missing_data: [
      !latestRecommendation ? "توصية ري حديثة" : null,
      !activeDevice ? "جهاز ESP32 فعّال" : null,
      !landOps.telemetry.length ? "قراءات حساسات" : null,
      !landOps.analyses.length ? "تحليل صورة حديث" : null
    ].filter(Boolean)
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
      decisionsResult,
      plansResult,
      recommendationsResult,
      devicesResult,
      telemetryResult,
      analysesResult,
      notesResult
    ] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,created_at").eq("id", landId).single(),
      supabase.from("ai_decisions").select("id,decision_json,evidence_counts,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("ai_action_plans").select("id,plan_json,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("irrigation_recommendations").select("id,total_liters_per_day,recommended_duration_seconds,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("iot_devices").select("id,device_uid,is_active,last_seen_at").eq("land_id", landId),
      supabase.from("iot_telemetry").select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,valve_state,captured_at,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("ai_analyses").select("id,plant_summary,pest_summary,confidence,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("field_notes").select("id,note,triage_json,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5)
    ]);

    if (landResult.error) throw landResult.error;

    const landOps = {
      land: landResult.data,
      decisions: decisionsResult.error ? [] : (decisionsResult.data ?? []),
      plans: plansResult.error ? [] : (plansResult.data ?? []),
      recommendations: recommendationsResult.error ? [] : (recommendationsResult.data ?? []),
      devices: devicesResult.error ? [] : (devicesResult.data ?? []),
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      analyses: analysesResult.error ? [] : (analysesResult.data ?? []),
      notes: notesResult.error ? [] : (notesResult.data ?? [])
    };

    let source = "gemini";
    let aiError: string | null = null;
    let checklist;

    try {
      checklist = await generateOperatorChecklist({
        landOps,
        weatherRisk: body.weatherRisk ?? null,
        place: body.place ?? null
      });
    } catch (error) {
      source = "rules_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      checklist = fallbackChecklist(landOps, aiError);
    }

    return NextResponse.json({ checklist: normalizeChecklist(checklist), source, aiError });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Operator checklist failed" },
      { status: 500 }
    );
  }
}
