import { NextResponse } from "next/server";
import { IRAQ_CROP_IRRIGATION_CATALOG, cropDailyLiters } from "@/lib/irrigation";

export async function GET() {
  return NextResponse.json({
    irrigationModes: [
      { id: "survival", nameAr: "البقاء على قيد الحياة", description: "أقل رية لتقليل خطر الذبول والموت، ليست هدف إنتاج." },
      { id: "medium_productivity", nameAr: "إنتاجية متوسطة", description: "ري ناقص منظم قريب من 50-70% من ETc لتقليل الهدر مع إنتاج مقبول." },
      { id: "full_irrigation", nameAr: "ري كامل", description: "تغطية الاحتياج المائي الكامل ETc بعد خصم المطر الفعال." }
    ],
    crops: IRAQ_CROP_IRRIGATION_CATALOG.map((crop) => ({
      ...crop,
      dailyLitersPerUnit: cropDailyLiters(crop)
    }))
  });
}
