import { NextRequest, NextResponse } from "next/server";
import { POST as runAutopilotRoute } from "@/app/api/agent/autopilot/route";

function isAuthorized(request: NextRequest) {
  const expected = process.env.AUTOPILOT_CRON_TOKEN;
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "AUTOPILOT_CRON_TOKEN is not configured"
    };
  }

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const headerToken = request.headers.get("x-cron-token")?.trim();
  const queryToken = request.nextUrl.searchParams.get("token")?.trim();
  const provided = bearer || headerToken || queryToken;

  if (provided !== expected) {
    return {
      ok: false,
      status: 401,
      error: "Invalid cron token"
    };
  }

  return { ok: true, status: 200, error: null };
}

function envNumber(name: string) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : undefined;
}

function parseBool(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return false;
}

function buildPayload(request: NextRequest, body: Record<string, unknown>) {
  const query = request.nextUrl.searchParams;
  const executeSafeAuto = parseBool(body.executeSafeAuto ?? query.get("executeSafeAuto"));
  const tankAvailableLiters =
    Number(body.tankAvailableLiters ?? query.get("tankAvailableLiters")) ||
    envNumber("AUTOPILOT_DEFAULT_TANK_AVAILABLE_LITERS");

  return {
    landId: body.landId ?? query.get("landId") ?? undefined,
    maxLands: Number(body.maxLands ?? query.get("maxLands") ?? process.env.AUTOPILOT_DEFAULT_MAX_LANDS ?? 12),
    flowRateLitersPerMinute: Number(
      body.flowRateLitersPerMinute ??
      query.get("flowRateLitersPerMinute") ??
      process.env.AUTOPILOT_DEFAULT_FLOW_LPM ??
      10
    ),
    tankCapacityLiters:
      Number(body.tankCapacityLiters ?? query.get("tankCapacityLiters")) ||
      envNumber("AUTOPILOT_DEFAULT_TANK_CAPACITY_LITERS"),
    tankAvailableLiters,
    tankReserveLiters:
      Number(body.tankReserveLiters ?? query.get("tankReserveLiters")) ||
      envNumber("AUTOPILOT_DEFAULT_TANK_RESERVE_LITERS") ||
      0,
    waterSavingPercent:
      Number(body.waterSavingPercent ?? query.get("waterSavingPercent")) ||
      envNumber("AUTOPILOT_DEFAULT_WATER_SAVING_PERCENT") ||
      70,
    irrigationMode: String(
      body.irrigationMode ??
      query.get("irrigationMode") ??
      process.env.AUTOPILOT_DEFAULT_IRRIGATION_MODE ??
      "medium_productivity"
    ),
    executeSafeAuto
  };
}

async function runCronAutopilot(request: NextRequest, body: Record<string, unknown>) {
  const auth = isAuthorized(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const payload = buildPayload(request, body);
  const internalRequest = new NextRequest(new URL("/api/agent/autopilot", request.url), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const response = await runAutopilotRoute(internalRequest);
  const result = await response.json();

  return NextResponse.json(
    {
      cron: {
        source: "protected_autopilot_cron",
        executed_at: new Date().toISOString(),
        execute_safe_auto: payload.executeSafeAuto,
        tank_limited: Number.isFinite(Number(payload.tankAvailableLiters))
      },
      ...result
    },
    { status: response.status }
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return runCronAutopilot(request, body);
}

export async function GET(request: NextRequest) {
  return runCronAutopilot(request, {});
}
