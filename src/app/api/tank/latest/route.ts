import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

function numberFromPayload(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return null;
  const parsed = Number((payload as Record<string, unknown>)[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function readTank(row: any, fallbackCapacityLiters: number | null) {
  const payload = row.raw_payload ?? {};
  if (
    payload &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).test_mode === true &&
    (payload as Record<string, unknown>).tank_sensor_source === undefined
  ) {
    return null;
  }

  const volume = numberFromPayload(payload, "tank_volume_liters");
  const level = numberFromPayload(payload, "tank_level_percent");
  const capacity = numberFromPayload(payload, "tank_capacity_liters") ?? fallbackCapacityLiters;

  if (Number.isFinite(Number(volume))) {
    return {
      capacity_liters: Number.isFinite(Number(capacity)) ? Math.max(1, Number(capacity)) : null,
      available_liters: Math.max(0, Number(volume)),
      level_percent: Number.isFinite(Number(level)) ? Math.max(0, Math.min(100, Number(level))) : null,
      sensor_source: typeof payload.tank_sensor_source === "string" ? payload.tank_sensor_source : "iot_telemetry",
      captured_at: row.captured_at ?? row.created_at ?? null,
      device_uid: row.device_uid ?? null,
      land_id: row.land_id
    };
  }

  if (Number.isFinite(Number(level)) && Number.isFinite(Number(capacity))) {
    const safeCapacity = Math.max(1, Number(capacity));
    const safeLevel = Math.max(0, Math.min(100, Number(level)));
    return {
      capacity_liters: safeCapacity,
      available_liters: safeCapacity * (safeLevel / 100),
      level_percent: safeLevel,
      sensor_source: typeof payload.tank_sensor_source === "string" ? payload.tank_sensor_source : "iot_telemetry",
      captured_at: row.captured_at ?? row.created_at ?? null,
      device_uid: row.device_uid ?? null,
      land_id: row.land_id
    };
  }

  return null;
}

export async function GET(request: NextRequest) {
  const landId = Number(request.nextUrl.searchParams.get("landId"));
  const fallbackCapacityLiters = Number(request.nextUrl.searchParams.get("tankCapacityLiters"));
  const supabase = createSupabaseAdmin();

  let query = supabase
    .from("iot_telemetry")
    .select("id,land_id,device_uid,raw_payload,captured_at,created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (Number.isFinite(landId) && landId > 0) {
    query = query.eq("land_id", landId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const latest = data?.[0];
  const latestPayload = latest?.raw_payload;
  if (
    latestPayload &&
    typeof latestPayload === "object" &&
    (latestPayload as Record<string, unknown>).test_mode === true &&
    (latestPayload as Record<string, unknown>).tank_sensor_source === undefined
  ) {
    return NextResponse.json(
      {
        error: "Latest ESP32 telemetry is test mode and has no tank sensor",
        source: "test_mode_no_tank_sensor",
        device_uid: latest.device_uid ?? null,
        captured_at: latest.captured_at ?? latest.created_at ?? null
      },
      { status: 404 }
    );
  }

  for (const row of data ?? []) {
    const reading = readTank(row, Number.isFinite(fallbackCapacityLiters) ? fallbackCapacityLiters : null);
    if (reading) {
      return NextResponse.json({
        source: "iot_telemetry",
        tank: reading
      });
    }
  }

  return NextResponse.json(
    {
      error: "No tank telemetry reading found",
      source: "missing"
    },
    { status: 404 }
  );
}
