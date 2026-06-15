import { NextResponse } from "next/server";
import { generateFieldWorkOrders } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function fallbackWorkOrders(state: any, aiError: string | null) {
  const latestAnalysis = state.analyses[0];
  const latestRecommendation = state.recommendations[0];
  const activeDevice = state.devices.some((device: any) => device.is_active);
  const hasTelemetry = state.telemetry.length > 0;
  const latestRisk = latestAnalysis?.pest_summary?.risk_level ?? "unknown";
  const orders = [
    !latestAnalysis ? {
      title: "التقط صورة ميدانية جديدة للتحليل",
      owner_role: "operator",
      priority: "high",
      due_in_hours: 6,
      why: "لا توجد تحليلات صورة كافية لدعم قرار الري والآفات.",
      how: "استخدم الهاتف أو الدرون والتقط صوراً للتاج والجذع ومنطقة الري.",
      success_check: "ظهور تحليل AI جديد مرتبط بالأرض.",
      evidence: ["لا توجد تحليلات حديثة"]
    } : null,
    latestRisk === "high" || latestRisk === "medium" ? {
      title: "فحص آفات ميداني قبل الري التلقائي",
      owner_role: "farmer",
      priority: latestRisk === "high" ? "high" : "medium",
      due_in_hours: 4,
      why: `خطر الآفات الأخير ${latestRisk}.`,
      how: "افحص ثقوب الجذع والإفرازات ونشارة الخشب وصوّر أي دليل قريب.",
      success_check: "تسجيل ملاحظة ميدانية أو صورة تثبت نتيجة الفحص.",
      evidence: [`خطر آفات: ${latestRisk}`]
    } : null,
    !latestRecommendation ? {
      title: "ولّد توصية ري قبل تشغيل المضخة",
      owner_role: "operator",
      priority: "high",
      due_in_hours: 8,
      why: "لا توجد توصية ري محفوظة يمكن تحويلها إلى أمر MQTT.",
      how: "شغّل تحليل صورة وحساب الري أو جدولة الري الذكية.",
      success_check: "ظهور توصية ري محفوظة بعدد لترات ومدة تشغيل.",
      evidence: ["لا توجد توصية ري محفوظة"]
    } : null,
    !activeDevice ? {
      title: "تجهيز ESP32 وربطه بالأرض",
      owner_role: "hardware",
      priority: "high",
      due_in_hours: 12,
      why: "الأتمتة تحتاج جهازاً فعالاً قبل إرسال أوامر MQTT.",
      how: "استخدم زر تجهيز ESP32 وانسخ إعدادات firmware للجهاز.",
      success_check: "ظهور جهاز فعال في مركز عمليات الأرض.",
      evidence: ["لا يوجد جهاز فعال"]
    } : null,
    !hasTelemetry ? {
      title: "إرسال قراءة telemetry من ESP32",
      owner_role: "hardware",
      priority: "medium",
      due_in_hours: 24,
      why: "قراءات الحساسات ترفع ثقة قرار الري وتثبت التشغيل للحكام.",
      how: "شغّل ESP32 وتأكد من POST إلى /api/iot/telemetry.",
      success_check: "ظهور قراءة رطوبة/حالة صمام في سجل الأرض.",
      evidence: ["لا توجد telemetry"]
    } : null
  ].filter(Boolean);

  return {
    headline: `أوامر عمل تشغيلية لأرض ${state.land?.name ?? "غير مسماة"}`,
    summary: "تم توليد أوامر العمل من سجلات Supabase الحالية بدون افتراض بيانات غير موجودة.",
    work_orders: orders.length ? orders : [{
      title: "مراجعة يومية وتوثيق الحالة",
      owner_role: "manager",
      priority: "low",
      due_in_hours: 24,
      why: "السجلات الحالية لا تظهر فجوة حرجة، لكن التوثيق يحسن قابلية العرض.",
      how: "راجع آخر توصية وقرار وجدولة واحفظ ملاحظة ميدانية قصيرة.",
      success_check: "وجود ملاحظة أو قرار حديث خلال 24 ساعة.",
      evidence: ["لا توجد فجوات حرجة ظاهرة"]
    }],
    manager_value: "أوامر العمل تحول الذكاء الاصطناعي إلى متابعة تشغيلية قابلة للتنفيذ والتدقيق.",
    missing_data: [
      aiError ? "Gemini غير متاح حالياً؛ تم استخدام قواعد تشغيلية" : null,
      !latestAnalysis ? "تحليل صورة حديث" : null,
      !latestRecommendation ? "توصية ري محفوظة" : null,
      !activeDevice ? "جهاز ESP32 فعال" : null,
      !hasTelemetry ? "قراءات حساسات" : null
    ].filter(Boolean)
  };
}

function dueAt(hours: number) {
  const date = new Date();
  date.setHours(date.getHours() + Math.max(1, Math.min(168, Number(hours) || 24)));
  return date.toISOString();
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [
      landResult,
      analysesResult,
      recommendationsResult,
      devicesResult,
      telemetryResult,
      commandsResult,
      decisionsResult,
      plansResult,
      schedulesResult,
      notesResult
    ] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,auto_irrigation_enabled,created_at").eq("id", landId).single(),
      supabase.from("ai_analyses").select("id,plant_summary,pest_summary,confidence,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("irrigation_recommendations").select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("iot_devices").select("id,device_uid,is_active,last_seen_at,created_at").eq("land_id", landId),
      supabase.from("iot_telemetry").select("id,device_uid,soil_moisture_percent,valve_state,captured_at,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("iot_commands").select("id,status,payload,ack_payload,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("ai_decisions").select("id,decision_json,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("ai_action_plans").select("id,plan_json,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("irrigation_schedules").select("id,schedule_json,source,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(3),
      supabase.from("field_notes").select("id,note,triage_json,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5)
    ]);

    for (const result of [landResult, analysesResult, recommendationsResult, devicesResult, commandsResult]) {
      if (result.error) throw result.error;
    }

    const operationsState = {
      land: landResult.data,
      analyses: analysesResult.data ?? [],
      recommendations: recommendationsResult.data ?? [],
      devices: devicesResult.data ?? [],
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      commands: commandsResult.data ?? [],
      decisions: decisionsResult.error ? [] : (decisionsResult.data ?? []),
      plans: plansResult.error ? [] : (plansResult.data ?? []),
      schedules: schedulesResult.error ? [] : (schedulesResult.data ?? []),
      notes: notesResult.error ? [] : (notesResult.data ?? [])
    };

    let source = "ai";
    let aiError: string | null = null;
    let workPlan;

    try {
      workPlan = await generateFieldWorkOrders({ operationsState });
    } catch (error) {
      source = "rules_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      workPlan = fallbackWorkOrders(operationsState, aiError);
    }

    const rows = (workPlan.work_orders ?? []).slice(0, 8).map((task: any) => ({
      land_id: landId,
      task_json: task,
      source,
      priority: ["low", "medium", "high"].includes(task.priority) ? task.priority : "medium",
      owner_role: ["farmer", "operator", "manager", "hardware"].includes(task.owner_role) ? task.owner_role : "operator",
      due_at: dueAt(task.due_in_hours)
    }));

    const { data: savedRows, error: saveError } = rows.length
      ? await supabase.from("field_work_orders").insert(rows).select("id")
      : { data: [], error: null } as any;

    return NextResponse.json({
      workPlan,
      source,
      aiError,
      saved: saveError ? null : { count: savedRows?.length ?? 0, ids: (savedRows ?? []).map((row: any) => row.id) },
      saveError: saveError ? "شغّل outputs/field_work_orders_schema.sql في Supabase SQL Editor حتى يتم حفظ أوامر العمل." : null,
      evidenceCounts: {
        analyses: operationsState.analyses.length,
        recommendations: operationsState.recommendations.length,
        devices: operationsState.devices.length,
        telemetry: operationsState.telemetry.length,
        decisions: operationsState.decisions.length,
        schedules: operationsState.schedules.length,
        notes: operationsState.notes.length
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Work orders failed" },
      { status: 500 }
    );
  }
}
