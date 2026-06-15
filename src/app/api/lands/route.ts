import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

function errorMessage(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);

  if (
    message.includes("Could not find the table 'public.lands'") ||
    message.includes("Could not find the function public.insert_land_from_geojson")
  ) {
    return "قاعدة البيانات غير مهيأة بعد. افتح Supabase SQL Editor وشغل ملف supabase/schema.sql لإنشاء الجداول ودالة حفظ الأرض.";
  }

  return message;
}

function geojsonPolygonToWkt(geojson: unknown) {
  const geometry = geojson && typeof geojson === "object" && "type" in geojson
    ? geojson as { type?: string; coordinates?: unknown }
    : null;
  const polygon = geometry?.type === "Feature"
    ? (geojson as { geometry?: { type?: string; coordinates?: unknown } }).geometry
    : geometry;

  if (!polygon || polygon.type !== "Polygon" || !Array.isArray(polygon.coordinates)) {
    throw new Error("boundary_geojson must be a Polygon GeoJSON geometry");
  }

  const rings = polygon.coordinates as unknown[];
  const wktRings = rings.map((ring) => {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new Error("Polygon rings must contain at least 4 points");
    }

    return `(${ring.map((point) => {
      if (!Array.isArray(point) || point.length < 2) {
        throw new Error("Polygon points must be [longitude, latitude]");
      }
      const longitude = Number(point[0]);
      const latitude = Number(point[1]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        throw new Error("Polygon points must contain valid numbers");
      }
      return `${longitude} ${latitude}`;
    }).join(",")})`;
  });

  return `POLYGON(${wktRings.join(",")})`;
}

function isMissingSoftDeleteColumn(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("deleted_at")
    || message.includes("deleted_by")
    || message.includes("delete_reason")
    || message.includes("schema cache");
}

async function requesterCanModifyLand(input: {
  supabase: ReturnType<typeof createSupabaseAdmin>;
  requesterId: string;
  landId: number;
}) {
  const { data: requester, error: requesterError } = await input.supabase
    .from("profiles")
    .select("role,is_active")
    .eq("id", input.requesterId)
    .maybeSingle();

  if (requesterError) throw requesterError;
  if (!requester || requester.is_active === false) {
    return { allowed: false, status: 403, error: "Inactive or missing requester", requester };
  }

  if (requester.role === "admin") {
    return { allowed: true, status: 200, error: null, requester };
  }

  const { data: membership, error: membershipError } = await input.supabase
    .from("land_memberships")
    .select("id")
    .eq("land_id", input.landId)
    .eq("profile_id", input.requesterId)
    .maybeSingle();

  if (membershipError) throw membershipError;

  const { data: land, error: landError } = await input.supabase
    .from("lands")
    .select("owner_id")
    .eq("id", input.landId)
    .maybeSingle();

  if (landError) throw landError;
  if (!land || (land.owner_id !== input.requesterId && !membership)) {
    return { allowed: false, status: 403, error: "You can modify only your linked lands", requester };
  }

  return { allowed: true, status: 200, error: null, requester };
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createSupabaseAdmin();
    const userId = request.nextUrl.searchParams.get("userId");
    const showDeleted = request.nextUrl.searchParams.get("deleted") === "1";
    let query = supabase
      .from("lands")
      .select("id,owner_id,name,crop_hint,boundary_geojson,area_m2,auto_irrigation_enabled,created_at,updated_at,deleted_at,deleted_by,delete_reason")
      .order("created_at", { ascending: false });

    query = showDeleted ? query.not("deleted_at", "is", null) : query.is("deleted_at", null);

    if (userId) {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();

      if (profileError) throw profileError;

      if (profile?.role !== "admin") {
        const { data: memberships, error: membershipError } = await supabase
          .from("land_memberships")
          .select("land_id")
          .eq("profile_id", userId);

        if (membershipError) throw membershipError;

        const landIds = (memberships ?? []).map((membership) => membership.land_id);
        query = landIds.length
          ? query.or(`owner_id.eq.${userId},id.in.(${landIds.join(",")})`)
          : query.eq("owner_id", userId);
      }
    }

    const initialResult = await query;
    let data: any[] | null = initialResult.data;
    let error: any = initialResult.error;

    if (error && isMissingSoftDeleteColumn(error)) {
      let fallbackQuery = supabase
        .from("lands")
        .select("id,owner_id,name,crop_hint,boundary_geojson,area_m2,auto_irrigation_enabled,created_at")
        .order("created_at", { ascending: false });

      if (showDeleted) {
        return NextResponse.json({
          lands: [],
          needsSoftDeleteSchema: true,
          message: "شغّل outputs/soft_delete_lands_schema.sql حتى تظهر محذوفات الأراضي."
        });
      }

      if (userId) {
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", userId)
          .maybeSingle();

        if (profileError) throw profileError;

        if (profile?.role !== "admin") {
          const { data: memberships, error: membershipError } = await supabase
            .from("land_memberships")
            .select("land_id")
            .eq("profile_id", userId);

          if (membershipError) throw membershipError;

          const landIds = (memberships ?? []).map((membership) => membership.land_id);
          fallbackQuery = landIds.length
            ? fallbackQuery.or(`owner_id.eq.${userId},id.in.(${landIds.join(",")})`)
            : fallbackQuery.eq("owner_id", userId);
        }
      }

      const fallback = await fallbackQuery;
      data = fallback.data;
      error = fallback.error;
    }

    if (error) throw error;
    const lands = data ?? [];
    const landIds = lands.map((land) => Number(land.id)).filter((id) => Number.isFinite(id) && id > 0);
    const latestImagesByLand = new Map<number, { image_url: string; signed_url: string | null; source: string | null }>();

    if (landIds.length) {
      const { data: imagery } = await supabase
        .from("imagery")
        .select("land_id,image_url,source,created_at")
        .in("land_id", landIds)
        .order("created_at", { ascending: false })
        .limit(Math.max(50, landIds.length * 3));

      for (const image of imagery ?? []) {
        const landId = Number(image.land_id);
        if (!Number.isFinite(landId) || latestImagesByLand.has(landId)) continue;
        const path = String(image.image_url ?? "");
        let signedUrl: string | null = null;
        if (path) {
          const { data: signed } = await supabase.storage
            .from("imagery")
            .createSignedUrl(path, 60 * 30);
          signedUrl = signed?.signedUrl ?? null;
        }
        latestImagesByLand.set(landId, {
          image_url: path,
          signed_url: signedUrl,
          source: image.source ?? null
        });
      }
    }

    return NextResponse.json({
      lands: lands.map((land) => ({
        ...land,
        latest_image: latestImagesByLand.get(Number(land.id)) ?? null
      }))
    });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const name = String(body.name ?? "").trim();
  const cropHint = String(body.crop_hint ?? "").trim();
  const boundaryGeojson = body.boundary_geojson;
  const autoIrrigation = Boolean(body.auto_irrigation_enabled);
  const ownerId = typeof body.owner_id === "string" ? body.owner_id : null;

  if (!name || !boundaryGeojson) {
    return NextResponse.json(
      { error: "name and boundary_geojson are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.rpc("insert_land_from_geojson", {
      land_name: name,
      crop: cropHint || null,
      geojson: boundaryGeojson,
      auto_irrigation: autoIrrigation
    });

    if (error) throw error;

    if (ownerId && data?.id) {
      const { error: updateError } = await supabase
        .from("lands")
        .update({ owner_id: ownerId })
        .eq("id", data.id);

      if (updateError) throw updateError;

      await supabase
        .from("land_memberships")
        .upsert(
          {
            land_id: data.id,
            profile_id: ownerId,
            role: "farmer"
          },
          { onConflict: "land_id,profile_id" }
        );

      data.owner_id = ownerId;
    }

    return NextResponse.json({ land: data });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const landId = Number(body.id ?? body.land_id);
  const action = String(body.action ?? "").trim().toLowerCase();
  const requesterId = typeof body.requester_id === "string" ? body.requester_id : null;

  if (action === "restore") {
    if (!Number.isFinite(landId) || landId <= 0 || !requesterId) {
      return NextResponse.json(
        { error: "id and requester_id are required to restore land" },
        { status: 400 }
      );
    }

    try {
      const supabase = createSupabaseAdmin();
      const permission = await requesterCanModifyLand({ supabase, requesterId, landId });
      if (!permission.allowed) {
        return NextResponse.json({ error: permission.error }, { status: permission.status });
      }

      const { data, error } = await supabase
        .from("lands")
        .update({
          deleted_at: null,
          deleted_by: null,
          delete_reason: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", landId)
        .select("id,owner_id,name,crop_hint,boundary_geojson,area_m2,auto_irrigation_enabled,created_at,updated_at,deleted_at")
        .maybeSingle();

      if (error && isMissingSoftDeleteColumn(error)) {
        return NextResponse.json(
          { error: "ميزة المحذوفات تحتاج تحديث قاعدة البيانات. شغّل outputs/soft_delete_lands_schema.sql في Supabase SQL Editor." },
          { status: 409 }
        );
      }
      if (error) throw error;
      if (!data) return NextResponse.json({ error: "Land was not found" }, { status: 404 });

      return NextResponse.json({ land: data, restored: true });
    } catch (error) {
      return NextResponse.json(
        { error: errorMessage(error) },
        { status: 500 }
      );
    }
  }

  const name = String(body.name ?? "").trim();
  const cropHint = String(body.crop_hint ?? "").trim();
  const boundaryGeojson = body.boundary_geojson;
  const autoIrrigation = Boolean(body.auto_irrigation_enabled);
  const ownerId = typeof body.owner_id === "string" ? body.owner_id : null;

  if (!Number.isFinite(landId) || landId <= 0 || !name || !boundaryGeojson) {
    return NextResponse.json(
      { error: "id, name, and boundary_geojson are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();

    if (requesterId) {
      const { data: requester, error: requesterError } = await supabase
        .from("profiles")
        .select("role,is_active")
        .eq("id", requesterId)
        .maybeSingle();

      if (requesterError) throw requesterError;
      if (!requester || requester.is_active === false) {
        return NextResponse.json({ error: "Inactive or missing requester" }, { status: 403 });
      }

      if (requester.role !== "admin") {
        return NextResponse.json({ error: "Only admins can update lands" }, { status: 403 });
      }
    }

    const { data, error } = await supabase
      .from("lands")
      .update({
        name,
        crop_hint: cropHint || null,
        boundary_geojson: boundaryGeojson,
        boundary_geom: `SRID=4326;${geojsonPolygonToWkt(boundaryGeojson)}`,
        auto_irrigation_enabled: autoIrrigation,
        owner_id: ownerId,
        updated_at: new Date().toISOString()
      })
      .eq("id", landId)
      .select("id,owner_id,name,crop_hint,boundary_geojson,area_m2,auto_irrigation_enabled,created_at,updated_at")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: "Land was not found" }, { status: 404 });
    }

    if (ownerId && data?.id) {
      await supabase
        .from("land_memberships")
        .upsert(
          {
            land_id: data.id,
            profile_id: ownerId,
            role: "farmer"
          },
          { onConflict: "land_id,profile_id" }
        );
    }

    return NextResponse.json({ land: data, updated: true });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const landId = Number(request.nextUrl.searchParams.get("id"));
  const requesterId = request.nextUrl.searchParams.get("requesterId");

  if (!Number.isFinite(landId) || !requesterId) {
    return NextResponse.json(
      { error: "id and requesterId are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    const permission = await requesterCanModifyLand({ supabase, requesterId, landId });
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const { data, error } = await supabase
      .from("lands")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: requesterId,
        delete_reason: "Archived from AgriAI platform. IoT devices and history are preserved for restore/relink.",
        auto_irrigation_enabled: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", landId)
      .select("id,name,deleted_at")
      .maybeSingle();

    if (error && isMissingSoftDeleteColumn(error)) {
      return NextResponse.json(
        { error: "حذف الأراضي الآمن يحتاج تحديث قاعدة البيانات. شغّل outputs/soft_delete_lands_schema.sql في Supabase SQL Editor حتى لا تنحذف أجهزة ESP32 مع الأرض." },
        { status: 409 }
      );
    }
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Land was not found" }, { status: 404 });

    return NextResponse.json({ deleted: true, archived: true, land: data });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 500 }
    );
  }
}
