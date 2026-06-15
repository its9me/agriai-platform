import { NextRequest, NextResponse } from "next/server";
import { generatePestResponsePlan } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function fallbackPestResponse(landOps: {
  land: any;
  analyses: any[];
  imagery: any[];
  notes: any[];
  recommendations: any[];
  devices: any[];
}, aiError: string | null) {
  const latestAnalysis = landOps.analyses[0];
  const pestSummary = latestAnalysis?.pest_summary ?? {};
  const risk = pestSummary.risk_level ?? "unknown";
  const redPalm = pestSummary.red_palm_weevil_indicators ?? {};
  const suspected = Boolean(redPalm.detected || risk === "high");
  const evidence = Array.isArray(redPalm.evidence) && redPalm.evidence.length
    ? redPalm.evidence
    : Array.isArray(pestSummary.suspected_pests)
      ? pestSummary.suspected_pests.flatMap((item: any) => item.evidence ?? []).slice(0, 4)
      : [];

  const missingData = [
    !landOps.analyses.length ? "تحليل صورة حديث" : null,
    !landOps.imagery.length ? "صور قريبة من الجذع والتاج" : null,
    !landOps.notes.length ? "ملاحظة ميدانية من المشغل" : null,
    aiError ? "Gemini غير متاح حالياً، تم استخدام خطة احتياطية" : null
  ].filter(Boolean) as string[];

  return {
    headline: suspected ? "استجابة أولية لاحتمال سوسة النخيل الحمراء" : "مراقبة آفات وقائية للأرض",
    pest_risk: ["none", "low", "medium", "high"].includes(risk) ? risk : "medium",
    red_palm_weevil_watch: {
      suspected,
      confidence: Number(redPalm.confidence ?? latestAnalysis?.confidence ?? 0.45),
      evidence: evidence.length ? evidence : ["لا توجد أدلة كافية؛ يلزم تصوير أدق قبل التشخيص."]
    },
    immediate_actions: [
      {
        title: suspected ? "اعزل النخلة/المنطقة المشتبه بها عن الري الزائد" : "نفذ فحص بصري سريع",
        priority: suspected ? "high" : "medium",
        owner: "operator",
        how: suspected
          ? "افحص الجذع والتاج بحثاً عن ثقوب، إفرازات، ألياف ممضوغة، أو نشارة قريبة من قاعدة النخلة."
          : "التقط صوراً واضحة للجذع والتاج وقاعدة السعف لأقرب نخيل تم تحليله.",
        done_when: "تم رفع صور جديدة أو إضافة ملاحظة ميدانية مرتبطة بالأرض."
      },
      {
        title: "لا ترسل ري تلقائي قبل مراجعة الخطر",
        priority: suspected ? "high" : "medium",
        owner: "manager",
        how: "راجع آخر توصية ري وقرار AI الموحد، ثم نفذ الري يدوياً فقط إذا لا توجد علامات آفات خطرة.",
        done_when: "تم توثيق قرار الري أو التأجيل في سجل الأرض."
      }
    ],
    photo_evidence_needed: [
      "صورة قريبة للجذع من 30-60 سم.",
      "صورة للتاج وقاعدة السعف.",
      "صورة لأي ثقوب أو إفرازات أو نشارة خشبية إن وجدت."
    ],
    irrigation_caution: suspected
      ? "أوقف الأتمتة مؤقتاً وراجع الري يدوياً لأن علامات الآفات قد تتطلب فحصاً قبل زيادة الرطوبة."
      : "يمكن الاستمرار بحذر حسب توصية الري، مع تحسين صور الآفات.",
    escalation: {
      needed: suspected,
      when: suspected ? "خلال 24 ساعة إذا ظهرت ثقوب أو إفرازات أو ذبول تاج." : "إذا ارتفع خطر التحليل إلى medium/high.",
      who: "خبير زراعي أو جهة مكافحة آفات محلية"
    },
    manager_value: "الخطة تحول كشف الآفات من ملاحظة عامة إلى إجراء ميداني موثق قابل للعرض أمام الحكام.",
    missing_data: missingData
  };
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [landResult, analysesResult, imageryResult, notesResult, recommendationsResult, devicesResult] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,created_at").eq("id", landId).single(),
      supabase.from("ai_analyses").select("id,plant_summary,pest_summary,confidence,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("imagery").select("id,image_url,source,captured_at,metadata,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("field_notes").select("id,note,triage_json,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("irrigation_recommendations").select("id,total_liters_per_day,recommended_duration_seconds,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("iot_devices").select("id,device_uid,is_active,last_seen_at").eq("land_id", landId)
    ]);

    if (landResult.error) throw landResult.error;

    const landOps = {
      land: landResult.data,
      analyses: analysesResult.error ? [] : (analysesResult.data ?? []),
      imagery: imageryResult.error ? [] : (imageryResult.data ?? []),
      notes: notesResult.error ? [] : (notesResult.data ?? []),
      recommendations: recommendationsResult.error ? [] : (recommendationsResult.data ?? []),
      devices: devicesResult.error ? [] : (devicesResult.data ?? [])
    };

    let source = "gemini";
    let aiError: string | null = null;
    let response;

    try {
      response = await generatePestResponsePlan({ landOps });
    } catch (error) {
      source = "rules_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      response = fallbackPestResponse(landOps, aiError);
    }

    return NextResponse.json({ response, source, aiError });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Pest response failed" },
      { status: 500 }
    );
  }
}
