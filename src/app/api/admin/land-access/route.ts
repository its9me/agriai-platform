import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("land_memberships")) {
    return "RBAC schema is not applied yet. Run outputs/rbac_schema.sql in Supabase SQL Editor.";
  }
  return message;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const requesterId = String(body.requester_id ?? "");
  const profileId = String(body.profile_id ?? "");
  const landId = Number(body.land_id);
  const role = String(body.role ?? "farmer");

  if (!requesterId || !profileId || !Number.isFinite(landId)) {
    return NextResponse.json(
      { error: "requester_id, profile_id and land_id are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data: requester, error: requesterError } = await supabase
      .from("profiles")
      .select("role,is_active")
      .eq("id", requesterId)
      .maybeSingle();

    if (requesterError) throw requesterError;
    if (!requester || requester.role !== "admin" || requester.is_active === false) {
      return NextResponse.json({ error: "Only active admins can link lands" }, { status: 403 });
    }

    const { data: membership, error: membershipError } = await supabase
      .from("land_memberships")
      .upsert(
        {
          land_id: landId,
          profile_id: profileId,
          role
        },
        { onConflict: "land_id,profile_id" }
      )
      .select("id,land_id,profile_id,role,created_at")
      .single();

    if (membershipError) throw membershipError;

    const { error: ownerError } = await supabase
      .from("lands")
      .update({ owner_id: profileId })
      .eq("id", landId);

    if (ownerError) throw ownerError;

    return NextResponse.json({ membership });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const requesterId = request.nextUrl.searchParams.get("requesterId") ?? "";
  const membershipId = Number(request.nextUrl.searchParams.get("membershipId"));

  if (!requesterId || !Number.isFinite(membershipId)) {
    return NextResponse.json(
      { error: "requesterId and membershipId are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data: requester, error: requesterError } = await supabase
      .from("profiles")
      .select("role,is_active")
      .eq("id", requesterId)
      .maybeSingle();

    if (requesterError) throw requesterError;
    if (!requester || requester.role !== "admin" || requester.is_active === false) {
      return NextResponse.json({ error: "Only active admins can unlink lands" }, { status: 403 });
    }

    const { data: membership, error: lookupError } = await supabase
      .from("land_memberships")
      .select("land_id,profile_id")
      .eq("id", membershipId)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!membership) {
      return NextResponse.json({ error: "Membership not found" }, { status: 404 });
    }

    const { error: deleteError } = await supabase
      .from("land_memberships")
      .delete()
      .eq("id", membershipId);

    if (deleteError) throw deleteError;

    const { error: ownerError } = await supabase
      .from("lands")
      .update({ owner_id: null })
      .eq("id", membership.land_id)
      .eq("owner_id", membership.profile_id);

    if (ownerError) throw ownerError;

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
