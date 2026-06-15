import { NextResponse } from "next/server";
import { generateDailyBrief } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export async function POST() {
  try {
    const supabase = createSupabaseAdmin();
    const [
      landsResult,
      analysesResult,
      recommendationsResult,
      devicesResult,
      notesResult,
      plansResult
    ] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,auto_irrigation_enabled,created_at").order("created_at", { ascending: false }),
      supabase.from("ai_analyses").select("id,land_id,pest_summary,confidence,created_at").order("created_at", { ascending: false }).limit(12),
      supabase.from("irrigation_recommendations").select("id,land_id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at").order("created_at", { ascending: false }).limit(12),
      supabase.from("iot_devices").select("id,land_id,device_uid,is_active,last_seen_at"),
      supabase.from("field_notes").select("id,land_id,note,triage_json,created_at").order("created_at", { ascending: false }).limit(8),
      supabase.from("ai_action_plans").select("id,land_id,plan_json,status,created_at").order("created_at", { ascending: false }).limit(8)
    ]);

    for (const result of [landsResult, analysesResult, recommendationsResult, devicesResult]) {
      if (result.error) throw result.error;
    }

    const platformState = {
      generatedAt: new Date().toISOString(),
      lands: landsResult.data ?? [],
      analyses: analysesResult.data ?? [],
      recommendations: recommendationsResult.data ?? [],
      devices: devicesResult.data ?? [],
      fieldNotes: notesResult.error ? [] : (notesResult.data ?? []),
      actionPlans: plansResult.error ? [] : (plansResult.data ?? []),
      knownMissing: [
        "بيانات MQTT الفعلية غير مكتملة بعد",
        "لا توجد حساسات رطوبة تربة متصلة بعد",
        "أرشفة صور الدرون الكاملة تحتاج تفعيل Supabase Storage workflow"
      ]
    };

    const brief = await generateDailyBrief({ platformState });

    return NextResponse.json({ brief, platformState });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Daily brief failed" },
      { status: 500 }
    );
  }
}
