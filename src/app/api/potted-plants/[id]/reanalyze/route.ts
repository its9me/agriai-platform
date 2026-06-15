import { NextRequest, NextResponse } from "next/server";
import { analyzePottedPlantFromBytes, POTTED_PLANTS_BUCKET, savePottedIrrigationRecommendation } from "@/lib/potted-plants";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function schemaError(message: string) {
  if (message.toLowerCase().includes("potted_plants")) {
    return "جدول النباتات الفردية غير موجود بعد. شغّل outputs/potted_plants_schema.sql داخل Supabase SQL Editor.";
  }
  return message;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const plantId = Number(id);
  const body = await request.json().catch(() => ({}));
  const flowRateLitersPerMinute = Math.max(0.1, Number(body.flowRateLitersPerMinute ?? 10) || 10);

  if (!Number.isFinite(plantId) || plantId <= 0) {
    return NextResponse.json({ error: "invalid potted plant id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data: plant, error: plantError } = await supabase
      .from("potted_plants")
      .select("id,linked_land_id,name,image_url,image_metadata,notes")
      .eq("id", plantId)
      .maybeSingle();

    if (plantError) throw plantError;
    if (!plant) return NextResponse.json({ error: "Potted plant was not found" }, { status: 404 });

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from(POTTED_PLANTS_BUCKET)
      .download(plant.image_url);

    if (downloadError) throw downloadError;

    const bytes = Buffer.from(await fileBlob.arrayBuffer());
    const result = await analyzePottedPlantFromBytes({
      supabase,
      bytes,
      mimeType: plant.image_metadata?.mimeType || "image/jpeg",
      flowRateLitersPerMinute,
      notes: String(plant.notes ?? ""),
      linkedLandId: Number(plant.linked_land_id)
    });

    const { data: updated, error: updateError } = await supabase
      .from("potted_plants")
      .update({
        analysis_json: result.analysis,
        command_preview: result.commandPreview,
        sensor_context: result.sensorContext,
        flow_rate_liters_per_minute: flowRateLitersPerMinute,
        updated_at: new Date().toISOString()
      })
      .eq("id", plantId)
      .select("id,owner_id,linked_land_id,name,location_label,image_url,image_metadata,analysis_json,command_preview,sensor_context,flow_rate_liters_per_minute,notes,status,created_at,updated_at")
      .single();

    if (updateError) throw updateError;

    const recommendation = await savePottedIrrigationRecommendation({
      supabase,
      landId: updated.linked_land_id,
      commandPreview: result.commandPreview,
      flowRateLitersPerMinute,
      sourceLabel: "Generated from saved potted plant image and latest ESP32 sensors"
    });

    return NextResponse.json({
      plant: updated,
      analysis: result.analysis,
      commandPreview: result.commandPreview,
      sensorContext: result.sensorContext,
      recommendation,
      saved: { pottedPlantId: updated.id, reusedImage: true }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reanalyze potted plant";
    return NextResponse.json({ error: schemaError(message) }, { status: 500 });
  }
}
