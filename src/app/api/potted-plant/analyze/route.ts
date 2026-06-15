import { NextRequest, NextResponse } from "next/server";
import {
  analyzePottedPlantFromBytes,
  ensurePottedPlantBucket,
  imageSha256,
  inferPottedPlantName,
  POTTED_PLANTS_BUCKET,
  safePottedPlantStorageName,
  savePottedIrrigationRecommendation
} from "@/lib/potted-plants";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const image = form.get("image");
  const flowRateLitersPerMinute = Math.max(0.1, Number(form.get("flowRateLitersPerMinute") ?? 10) || 10);
  const landId = Number(form.get("landId"));
  const ownerId = String(form.get("ownerId") ?? "").trim() || null;
  const savePlant = String(form.get("savePlant") ?? "true") !== "false";
  const plantName = String(form.get("plantName") ?? "").trim();
  const locationLabel = String(form.get("locationLabel") ?? "").trim();
  const notes = String(form.get("notes") ?? "").trim();

  if (!(image instanceof File)) {
    return NextResponse.json({ error: "image file is required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const bytes = Buffer.from(await image.arrayBuffer());
    const result = await analyzePottedPlantFromBytes({
      supabase,
      bytes,
      mimeType: image.type || "image/jpeg",
      flowRateLitersPerMinute,
      notes,
      linkedLandId: Number.isFinite(landId) && landId > 0 ? landId : null
    });

    let saved: null | { pottedPlantId: number; imagePath: string } = null;
    let recommendation = null;
    if (savePlant) {
      await ensurePottedPlantBucket(supabase);
      const sha256 = imageSha256(bytes);
      const storagePath = `potted-plants/${ownerId ?? "unassigned"}/${Date.now()}-${safePottedPlantStorageName(image.name)}`;
      const { error: uploadError } = await supabase.storage
        .from(POTTED_PLANTS_BUCKET)
        .upload(storagePath, bytes, {
          contentType: image.type || "image/jpeg",
          upsert: false
        });

      if (uploadError) throw uploadError;

      const { data: row, error: insertError } = await supabase
        .from("potted_plants")
        .insert({
          owner_id: ownerId,
          linked_land_id: Number.isFinite(landId) && landId > 0 ? landId : null,
          name: plantName || inferPottedPlantName(result.analysis, image.name),
          location_label: locationLabel || null,
          image_url: storagePath,
          image_metadata: {
            bucket: POTTED_PLANTS_BUCKET,
            originalName: image.name,
            mimeType: image.type || "image/jpeg",
            size: image.size,
            sha256
          },
          analysis_json: result.analysis,
          command_preview: result.commandPreview,
          sensor_context: result.sensorContext,
          flow_rate_liters_per_minute: flowRateLitersPerMinute,
          notes: notes || null
        })
        .select("id,image_url")
        .single();

      if (insertError) throw insertError;
      saved = { pottedPlantId: row.id, imagePath: row.image_url };
    }

    if (Number.isFinite(landId) && landId > 0) {
      recommendation = await savePottedIrrigationRecommendation({
        supabase,
        landId,
        commandPreview: result.commandPreview,
        flowRateLitersPerMinute,
        sourceLabel: "Generated from new potted plant image and latest ESP32 sensors"
      });
    }

    return NextResponse.json({
      analysis: result.analysis,
      sensorContext: result.sensorContext,
      commandPreview: result.commandPreview,
      recommendation,
      saved
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Potted plant analysis failed";
    return NextResponse.json(
      {
        error: message.toLowerCase().includes("potted_plants")
          ? "جدول النباتات الفردية غير موجود بعد. شغّل outputs/potted_plants_schema.sql داخل Supabase SQL Editor."
          : message
      },
      { status: 500 }
    );
  }
}
