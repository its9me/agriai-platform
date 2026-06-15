import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

function missingRbacMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("email") || message.includes("land_memberships")) {
    return "RBAC schema is not applied yet. Run outputs/rbac_schema.sql in Supabase SQL Editor.";
  }
  return message;
}

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id,email,full_name,role,is_active,created_at")
      .eq("id", userId)
      .maybeSingle();

    if (profileError) throw profileError;

    const { data: memberships, error: membershipError } = await supabase
      .from("land_memberships")
      .select("id,land_id,role,created_at,lands(id,name,crop_hint,area_m2)")
      .eq("profile_id", userId)
      .order("created_at", { ascending: false });

    if (membershipError) throw membershipError;

    return NextResponse.json({ profile, memberships: memberships ?? [] });
  } catch (error) {
    return NextResponse.json({ error: missingRbacMessage(error) }, { status: 500 });
  }
}
