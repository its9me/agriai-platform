import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function assertAdmin(supabase: ReturnType<typeof createSupabaseAdmin>, requesterId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("role,is_active")
    .eq("id", requesterId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data && data.role === "admin" && data.is_active !== false);
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("land_plants")) {
    return "Manual plants schema is not applied yet. Run outputs/land_plants_schema.sql in Supabase SQL Editor.";
  }
  return message;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase
      .from("land_plants")
      .select("id,land_id,name,count,growth_stage,notes,source,created_at,updated_at")
      .eq("land_id", landId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ plants: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const body = await request.json();
  const requesterId = String(body.requester_id ?? "");
  const name = String(body.name ?? "").trim();
  const count = Number(body.count);
  const growthStage = String(body.growth_stage ?? "unknown").trim() || "unknown";
  const notes = String(body.notes ?? "").trim();

  if (!Number.isFinite(landId) || !requesterId || !name || !Number.isFinite(count) || count < 0) {
    return NextResponse.json(
      { error: "land id, requester_id, name and valid count are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    if (!await assertAdmin(supabase, requesterId)) {
      return NextResponse.json({ error: "Only admins can add manual plants" }, { status: 403 });
    }

    const { data, error } = await supabase
      .from("land_plants")
      .insert({
        land_id: landId,
        name,
        count,
        growth_stage: growthStage,
        notes: notes || null,
        source: "manual"
      })
      .select("id,land_id,name,count,growth_stage,notes,source,created_at,updated_at")
      .single();

    if (error) throw error;
    return NextResponse.json({ plant: data });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const requesterId = request.nextUrl.searchParams.get("requesterId") ?? "";
  const plantId = Number(request.nextUrl.searchParams.get("plantId"));

  if (!Number.isFinite(landId) || !requesterId || !Number.isFinite(plantId)) {
    return NextResponse.json(
      { error: "land id, requesterId and plantId are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    if (!await assertAdmin(supabase, requesterId)) {
      return NextResponse.json({ error: "Only admins can delete manual plants" }, { status: 403 });
    }

    const { error } = await supabase
      .from("land_plants")
      .delete()
      .eq("id", plantId)
      .eq("land_id", landId);

    if (error) throw error;
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
