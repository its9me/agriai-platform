import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  const lon = Number(request.nextUrl.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("zoom", "12");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "ar,en");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "AgriAI-Precision-Platform-MVP/0.1 contact=local-demo"
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const address = data.address ?? {};

    return NextResponse.json({
      displayName: data.display_name ?? "",
      city: address.city ?? address.town ?? address.village ?? address.hamlet ?? "",
      district: address.county ?? address.district ?? "",
      governorate: address.state ?? address.province ?? "",
      country: address.country ?? "",
      raw: address
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reverse geocoding failed" },
      { status: 500 }
    );
  }
}
