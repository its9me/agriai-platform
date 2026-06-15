import { NextRequest, NextResponse } from "next/server";
import { getWeather } from "@/lib/weather";

export async function GET(request: NextRequest) {
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  const lon = Number(request.nextUrl.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  try {
    return NextResponse.json(await getWeather(lat, lon));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Weather request failed" },
      { status: 500 }
    );
  }
}
