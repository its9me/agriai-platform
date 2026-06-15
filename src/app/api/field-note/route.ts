import { NextRequest, NextResponse } from "next/server";
import { triageFieldNote } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const note = String(body.note ?? "").trim();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const landId = Number(body.landId);

  if (!note || note.length < 8) {
    return NextResponse.json(
      { error: "اكتب ملاحظة ميدانية أوضح قبل التشخيص." },
      { status: 400 }
    );
  }

  try {
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(lat, lon)
      : null;

    const triage = await triageFieldNote({
      note,
      land: {
        name: String(body.landName ?? ""),
        cropHint: String(body.cropHint ?? ""),
        areaM2: Number(body.areaM2 ?? 0)
      },
      place: body.place ?? null,
      weather,
      platformContext: {
        hasSelectedLand: Boolean(body.landId),
        hasRecentImageAnalysis: Boolean(body.hasRecentImageAnalysis),
        hasIotDevice: Boolean(body.hasIotDevice)
      }
    });

    let saved: null | { fieldNoteId: number } = null;
    if (Number.isFinite(landId) && landId > 0) {
      const supabase = createSupabaseAdmin();
      const { data, error } = await supabase
        .from("field_notes")
        .insert({
          land_id: landId,
          note,
          triage_json: triage,
          weather_snapshot: weather,
          source: "manual"
        })
        .select("id")
        .single();

      if (!error && data) {
        saved = { fieldNoteId: data.id };
      }
    }

    return NextResponse.json({ triage, weather, saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Field note triage failed" },
      { status: 500 }
    );
  }
}
