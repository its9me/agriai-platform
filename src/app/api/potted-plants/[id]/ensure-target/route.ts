import { NextRequest, NextResponse } from "next/server";
import { savePottedIrrigationRecommendation } from "@/lib/potted-plants";
import { estimatePottedTargetAreaM2, pottedPlantNameFromAnalysis, squareGeojsonAroundPoint } from "@/lib/potted-target";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function schemaError(message: string) {
  if (message.toLowerCase().includes("potted_plants")) {
    return "جدول النباتات الفردية يحتاج تحديث. شغّل outputs/potted_plants_schema.sql داخل Supabase SQL Editor.";
  }
  return message;
}

function geojsonPolygonToWkt(geojson: { coordinates: number[][][] }) {
  const ring = geojson.coordinates[0];
  return `POLYGON((${ring.map((point) => `${point[0]} ${point[1]}`).join(",")}))`;
}

function isPottedTargetLand(land: { name?: string | null; crop_hint?: string | null } | null, plantName: string) {
  const name = String(land?.name ?? "").trim();
  if (!name) return false;
  const normalizedPlantName = plantName.trim().toLowerCase();
  const normalizedLandName = name.toLowerCase();
  return normalizedLandName.startsWith("نبات:")
    || normalizedLandName.startsWith("plant:")
    || (normalizedLandName.includes(normalizedPlantName) && normalizedLandName.includes("نبات"));
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const plantId = Number(id);
  const body = await request.json().catch(() => ({}));
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const ownerId = typeof body.owner_id === "string" ? body.owner_id : null;
  const autoIrrigationEnabled = body.auto_irrigation_enabled !== false;

  if (!Number.isFinite(plantId) || plantId <= 0) {
    return NextResponse.json({ error: "invalid potted plant id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data: pottedPlant, error: plantError } = await supabase
      .from("potted_plants")
      .select("id,owner_id,linked_land_id,name,analysis_json,command_preview,flow_rate_liters_per_minute,notes")
      .eq("id", plantId)
      .maybeSingle();

    if (plantError) throw plantError;
    if (!pottedPlant) return NextResponse.json({ error: "Potted plant was not found" }, { status: 404 });

    const areaM2 = estimatePottedTargetAreaM2(pottedPlant.analysis_json);
    const boundaryGeojson = squareGeojsonAroundPoint({ lat, lon, areaM2 });
    const targetName = `نبات: ${pottedPlant.name}`;
    const cropHint = pottedPlantNameFromAnalysis(pottedPlant.analysis_json, pottedPlant.name);

    let landId = Number(pottedPlant.linked_land_id);
    let land: any = null;

    if (Number.isFinite(landId) && landId > 0) {
      const { data: existingLand, error: existingLandError } = await supabase
        .from("lands")
        .select("id,name,crop_hint")
        .eq("id", landId)
        .maybeSingle();

      if (existingLandError) throw existingLandError;

      if (!isPottedTargetLand(existingLand, pottedPlant.name)) {
        landId = NaN;
      } else {
        const { data, error } = await supabase
        .from("lands")
        .update({
          name: targetName,
          crop_hint: cropHint,
          boundary_geojson: boundaryGeojson,
          boundary_geom: `SRID=4326;${geojsonPolygonToWkt(boundaryGeojson)}`,
          auto_irrigation_enabled: autoIrrigationEnabled,
          owner_id: ownerId ?? pottedPlant.owner_id ?? null,
          updated_at: new Date().toISOString()
        })
        .eq("id", landId)
        .select("id,owner_id,name,crop_hint,boundary_geojson,area_m2,auto_irrigation_enabled,created_at,updated_at")
        .maybeSingle();

        if (error) throw error;
        land = data;
      }
    }

    if (!land) {
      const { data, error } = await supabase.rpc("insert_land_from_geojson", {
        land_name: targetName,
        crop: cropHint,
        geojson: boundaryGeojson,
        auto_irrigation: autoIrrigationEnabled
      });

      if (error) throw error;
      land = data;
      landId = Number(data.id);

      if ((ownerId ?? pottedPlant.owner_id) && landId) {
        const profileId = ownerId ?? pottedPlant.owner_id;
        await supabase.from("lands").update({ owner_id: profileId }).eq("id", landId);
        await supabase.from("land_memberships").upsert(
          {
            land_id: landId,
            profile_id: profileId,
            role: "farmer"
          },
          { onConflict: "land_id,profile_id" }
        );
      }
    }

    const { data: updatedPlant, error: updatePlantError } = await supabase
      .from("potted_plants")
      .update({
        linked_land_id: landId,
        target_boundary_geojson: boundaryGeojson,
        target_area_m2: areaM2,
        updated_at: new Date().toISOString()
      })
      .eq("id", plantId)
      .select("id,owner_id,linked_land_id,name,location_label,image_url,image_metadata,target_boundary_geojson,target_area_m2,analysis_json,command_preview,sensor_context,flow_rate_liters_per_minute,notes,status,created_at,updated_at")
      .single();

    if (updatePlantError) throw updatePlantError;

    const { data: existingPlantRow } = await supabase
      .from("land_plants")
      .select("id")
      .eq("land_id", landId)
      .eq("name", cropHint)
      .limit(1)
      .maybeSingle();

    if (!existingPlantRow) {
      await supabase.from("land_plants").insert({
        land_id: landId,
        name: cropHint,
        count: 1,
        growth_stage: String((pottedPlant.analysis_json as any)?.plant?.growth_stage ?? "unknown"),
        notes: "Generated from saved potted-plant AI analysis.",
        source: "image_ai"
      });
    }

    const recommendation = await savePottedIrrigationRecommendation({
      supabase,
      landId,
      commandPreview: updatedPlant.command_preview ?? pottedPlant.command_preview,
      flowRateLitersPerMinute: Number(updatedPlant.flow_rate_liters_per_minute ?? pottedPlant.flow_rate_liters_per_minute ?? 10),
      sourceLabel: "Generated when potted plant target was prepared"
    });

    return NextResponse.json({
      plant: updatedPlant,
      land,
      boundary: boundaryGeojson,
      areaM2,
      recommendation,
      autoIrrigationEnabled
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to prepare potted plant target";
    return NextResponse.json({ error: schemaError(message) }, { status: 500 });
  }
}
