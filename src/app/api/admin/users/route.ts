import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type NewUserBody = {
  requester_id?: string;
  bootstrap?: boolean;
  email?: string;
  password?: string;
  full_name?: string;
  role?: "farmer" | "admin" | "operator";
};

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("email") || message.includes("land_memberships")) {
    return "RBAC schema is not applied yet. Run outputs/rbac_schema.sql in Supabase SQL Editor.";
  }
  return message;
}

async function assertAdmin(supabase: ReturnType<typeof createSupabaseAdmin>, requesterId?: string, bootstrap = false) {
  const { error: countError } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true });

  if (countError) throw countError;
  if (bootstrap) {
    const { count: adminCount, error: adminCountError } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin");

    if (adminCountError) throw adminCountError;
    if ((adminCount ?? 0) === 0) return;
  }

  if (!requesterId) {
    throw new Error("requester_id is required for admin actions");
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("role,is_active")
    .eq("id", requesterId)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.role !== "admin" || data.is_active === false) {
    throw new Error("Only active admins can manage users");
  }
}

export async function GET(request: NextRequest) {
  const requesterId = request.nextUrl.searchParams.get("requesterId") ?? undefined;

  try {
    const supabase = createSupabaseAdmin();
    await assertAdmin(supabase, requesterId);

    const { data, error } = await supabase
      .from("profiles")
      .select("id,email,full_name,role,is_active,created_at,land_memberships(id,land_id,role,lands(id,name))")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ users: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as NewUserBody;
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const fullName = String(body.full_name ?? "").trim();
  const role = body.role ?? "farmer";

  if (!email || !password || password.length < 6) {
    return NextResponse.json(
      { error: "email and password with at least 6 characters are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    await assertAdmin(supabase, body.requester_id, Boolean(body.bootstrap));

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role
      }
    });

    if (authError) throw authError;
    const userId = authData.user?.id;
    if (!userId) throw new Error("Supabase Auth did not return a user id");

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .upsert({
        id: userId,
        email,
        full_name: fullName || email,
        role,
        is_active: true
      })
      .select("id,email,full_name,role,is_active,created_at")
      .single();

    if (profileError) throw profileError;
    return NextResponse.json({ user: profile });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const requesterId = request.nextUrl.searchParams.get("requesterId") ?? undefined;
  const userId = request.nextUrl.searchParams.get("userId") ?? undefined;

  if (!requesterId || !userId) {
    return NextResponse.json(
      { error: "requesterId and userId are required" },
      { status: 400 }
    );
  }

  if (requesterId === userId) {
    return NextResponse.json(
      { error: "Admin cannot delete the active account from this screen" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdmin();
    await assertAdmin(supabase, requesterId);

    const { error: authError } = await supabase.auth.admin.deleteUser(userId);
    if (authError) throw authError;

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
