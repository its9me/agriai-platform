import { NextRequest, NextResponse } from "next/server";
import { generateLandAdvisory } from "@/lib/gemini";
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
    const advisory = await generateLandAdvisory({
      land: {
        id: Number.isFinite(Number(body.landId)) ? Number(body.landId) : undefined,
        name: String(body.landName ?? ""),
        cropHint: String(body.cropHint ?? ""),
        areaM2,
        autoIrrigationEnabled: Boolean(body.autoIrrigationEnabled)
      },
      place: body.place ?? null,
      weather,
      platform: {
        hasImageAnalysis: Boolean(body.hasImageAnalysis),
        hasIotDevice: Boolean(body.hasIotDevice),
        savedLandsCount: Number(body.savedLandsCount ?? 0)
      }
    });

    return NextResponse.json({ advisory, weather });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI advisor failed" },
      { status: 500 }
    );
  }
}
