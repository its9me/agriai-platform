import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

function schemaError(message: string) {
  if (message.toLowerCase().includes("potted_plants")) {
    return "جدول النباتات الفردية غير موجود بعد. شغّل outputs/potted_plants_schema.sql داخل Supabase SQL Editor.";
  }
  return message;
}

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");

  try {
    const supabase = createSupabaseAdmin();
    let query = supabase
      .from("potted_plants")
      .select("id,owner_id,linked_land_id,name,location_label,image_url,image_metadata,target_boundary_geojson,target_area_m2,analysis_json,command_preview,sensor_context,flow_rate_liters_per_minute,notes,status,created_at,updated_at")
      .eq("status", "active")
      .order("created_at", { ascending: false });

    if (userId) {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();

      if (profileError) throw profileError;
      if (profile?.role !== "admin") {
        query = query.eq("owner_id", userId);
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    const plants = data ?? [];
    const linkedLandIds = [...new Set(plants.map((plant) => Number(plant.linked_land_id)).filter((id) => Number.isFinite(id) && id > 0))];
    const landMap = new Map<number, { id: number; name: string; crop_hint: string | null }>();

    if (linkedLandIds.length) {
      const { data: linkedLands, error: landsError } = await supabase
        .from("lands")
        .select("id,name,crop_hint")
        .in("id", linkedLandIds);

      if (landsError) throw landsError;
      for (const land of linkedLands ?? []) {
        landMap.set(Number(land.id), land);
      }
    }

    const signedImages = new Map<number, string | null>();
    await Promise.all(plants.map(async (plant) => {
      const path = String(plant.image_url ?? "");
      if (!path) {
        signedImages.set(Number(plant.id), null);
        return;
      }
      const { data: signed } = await supabase.storage
        .from("imagery")
        .createSignedUrl(path, 60 * 30);
      signedImages.set(Number(plant.id), signed?.signedUrl ?? null);
    }));

    return NextResponse.json({
      plants: plants.map((plant) => ({
        ...plant,
        signed_image_url: signedImages.get(Number(plant.id)) ?? null,
        lands: plant.linked_land_id ? landMap.get(Number(plant.linked_land_id)) ?? null : null
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load potted plants";
    return NextResponse.json({ error: schemaError(message) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const plantId = Number(request.nextUrl.searchParams.get("id"));
  const requesterId = request.nextUrl.searchParams.get("requesterId");

  if (!Number.isFinite(plantId) || plantId <= 0 || !requesterId) {
    return NextResponse.json({ error: "id and requesterId are required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data: requester, error: requesterError } = await supabase
      .from("profiles")
      .select("role,is_active")
      .eq("id", requesterId)
      .maybeSingle();

    if (requesterError) throw requesterError;
    if (!requester || requester.is_active === false) {
      return NextResponse.json({ error: "Inactive or missing requester" }, { status: 403 });
    }

    let query = supabase.from("potted_plants").delete().eq("id", plantId);
    if (requester.role !== "admin") {
      query = query.eq("owner_id", requesterId);
    }

    const { error } = await query;
    if (error) throw error;
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete potted plant";
    return NextResponse.json({ error: schemaError(message) }, { status: 500 });
  }
}
