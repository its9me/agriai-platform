import { NextRequest, NextResponse } from "next/server";
import { savePottedIrrigationRecommendation } from "@/lib/potted-plants";
import { estimatePottedTargetAreaM2, pottedPlantNameFromAnalysis, squareGeojsonAroundPoint } from "@/lib/potted-target";
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
  const deviceUid = String(body.device_uid ?? "").trim();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const ownerId = typeof body.owner_id === "string" ? body.owner_id : null;

  if (!Number.isFinite(plantId) || plantId <= 0 || !deviceUid) {
    return NextResponse.json({ error: "plant id and device_uid are required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [plantResult, deviceResult] = await Promise.all([
      supabase
        .from("potted_plants")
        .select("id,owner_id,name,linked_land_id,analysis_json,command_preview,flow_rate_liters_per_minute")
        .eq("id", plantId)
        .maybeSingle(),
      supabase
        .from("iot_devices")
        .select("id,land_id,device_uid,is_active,last_seen_at,mqtt_topic_command,mqtt_topic_ack")
        .eq("device_uid", deviceUid)
        .maybeSingle()
    ]);

    if (plantResult.error) throw plantResult.error;
    if (deviceResult.error) throw deviceResult.error;

    if (!plantResult.data) {
      return NextResponse.json({ error: "Potted plant was not found" }, { status: 404 });
    }

    if (!deviceResult.data) {
      return NextResponse.json({ error: "ESP32 device was not found. Let it send telemetry once or register it first." }, { status: 404 });
    }

    const areaM2 = estimatePottedTargetAreaM2(plantResult.data.analysis_json);
    const boundaryGeojson = squareGeojsonAroundPoint({ lat, lon, areaM2 });
    const targetName = `نبات: ${plantResult.data.name}`;
    const cropHint = pottedPlantNameFromAnalysis(plantResult.data.analysis_json, plantResult.data.name);
    const previousLandId = Number(deviceResult.data.land_id);
    let landId = Number(plantResult.data.linked_land_id);
    let land: any = null;

    if (Number.isFinite(landId) && landId > 0) {
      const { data: existingLand, error: existingLandError } = await supabase
        .from("lands")
        .select("id,name,crop_hint")
        .eq("id", landId)
        .maybeSingle();

      if (existingLandError) throw existingLandError;

      if (!isPottedTargetLand(existingLand, plantResult.data.name)) {
        landId = NaN;
      } else {
        const { data, error } = await supabase
        .from("lands")
        .update({
          name: targetName,
          crop_hint: cropHint,
          boundary_geojson: boundaryGeojson,
          boundary_geom: `SRID=4326;${geojsonPolygonToWkt(boundaryGeojson)}`,
          owner_id: ownerId ?? plantResult.data.owner_id ?? null,
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
        auto_irrigation: true
      });

      if (error) throw error;
      land = data;
      landId = Number(data.id);

      const profileId = ownerId ?? plantResult.data.owner_id ?? null;
      if (profileId && landId) {
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

    const { data: plant, error: updateError } = await supabase
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

    if (updateError) throw updateError;

    const { data: device, error: updateDeviceError } = await supabase
      .from("iot_devices")
      .update({
        land_id: landId,
        is_active: true
      })
      .eq("id", deviceResult.data.id)
      .select("id,land_id,device_uid,is_active,last_seen_at,mqtt_topic_command,mqtt_topic_ack")
      .single();

    if (updateDeviceError) throw updateDeviceError;

    const recommendation = await savePottedIrrigationRecommendation({
      supabase,
      landId,
      commandPreview: plant.command_preview ?? plantResult.data.command_preview,
      flowRateLitersPerMinute: Number(plant.flow_rate_liters_per_minute ?? plantResult.data.flow_rate_liters_per_minute ?? 10),
      sourceLabel: "Generated when ESP32 was linked to potted plant"
    });

    return NextResponse.json({
      plant: {
        ...plant,
        lands: land
      },
      device,
      land,
      previousLandId,
      recommendation,
      note: "ESP32 was moved to this potted plant target. Commands and sensor telemetry will use the potted plant land_id."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to bind potted plant to ESP32";
    return NextResponse.json({ error: schemaError(message) }, { status: 500 });
  }
}
