import { NextRequest, NextResponse } from "next/server";
import { generatePhotoMission } from "@/lib/gemini";
import { getWeather } from "@/lib/weather";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const areaM2 = Number(body.areaM2);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(areaM2)) {
    return NextResponse.json({ error: "lat, lon, and areaM2 are required" }, { status: 400 });
  }

  try {
    const weather = await getWeather(lat, lon);
    const mission = await generatePhotoMission({
      land: {
        id: body.landId ?? null,
        name: body.landName ?? null,
        cropHint: body.cropHint ?? null,
        areaM2
      },
      place: body.place ?? null,
      weather,
      platformContext: {
        hasSelectedLand: Boolean(body.landId),
        hasRecentImageAnalysis: Boolean(body.hasRecentImageAnalysis),
        hasIotDevice: Boolean(body.hasIotDevice),
        targetPest: "red palm weevil"
      }
    });

    return NextResponse.json({ mission, weather });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Photo mission failed" },
      { status: 500 }
    );
  }
}
