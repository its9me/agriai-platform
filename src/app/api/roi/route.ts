import { NextRequest, NextResponse } from "next/server";
import { generateRoiNarrative } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const waterCostPerLiter = Number(body.waterCostPerLiter ?? 0);
  const laborCostPerInspection = Number(body.laborCostPerInspection ?? 0);
  const avoidedInspections = Number(body.avoidedInspections ?? 0);

  try {
    const supabase = createSupabaseAdmin();
    const [landsResult, recommendationsResult, analysesResult, notesResult] = await Promise.all([
      supabase.from("lands").select("id,area_m2"),
      supabase.from("irrigation_recommendations").select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,created_at"),
      supabase.from("ai_analyses").select("id"),
      supabase.from("field_notes").select("id")
    ]);

    if (landsResult.error) throw landsResult.error;
    if (recommendationsResult.error) throw recommendationsResult.error;
    if (analysesResult.error) throw analysesResult.error;

    const lands = landsResult.data ?? [];
    const recommendations = recommendationsResult.data ?? [];
    const analyses = analysesResult.data ?? [];
    const notes = notesResult.error ? [] : (notesResult.data ?? []);

    const measuredWaterSavingLiters = recommendations.reduce((sum, rec) => {
      return sum + Number(rec.rain_deduction_liters ?? 0);
    }, 0);
    const latestRecommendation = recommendations
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    const estimatedWaterSavingValue = measuredWaterSavingLiters * Math.max(0, waterCostPerLiter);
    const estimatedLaborSavingValue = Math.max(0, laborCostPerInspection) * Math.max(0, avoidedInspections);

    const metrics = {
      landsCount: lands.length,
      totalAreaM2: lands.reduce((sum, land) => sum + Number(land.area_m2 ?? 0), 0),
      recommendationsCount: recommendations.length,
      analysesCount: analyses.length,
      fieldNotesCount: notes.length,
      measuredWaterSavingLiters,
      latestRecommendedLiters: latestRecommendation?.total_liters_per_day ?? 0,
      latestRecommendedDurationSeconds: latestRecommendation?.recommended_duration_seconds ?? 0,
      estimatedWaterSavingValue,
      estimatedLaborSavingValue,
      estimatedTotalValue: estimatedWaterSavingValue + estimatedLaborSavingValue
    };

    const assumptions = {
      waterCostPerLiter,
      laborCostPerInspection,
      avoidedInspections,
      note: "القيم المالية تقديرية وتعتمد فقط على مدخلات المستخدم والتوصيات المحفوظة."
    };

    const narrative = await generateRoiNarrative({ metrics, assumptions });

    return NextResponse.json({ metrics, assumptions, narrative });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ROI calculation failed" },
      { status: 500 }
    );
  }
}
