import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const landId = Number(body.land_id);
  const deviceUid = String(body.device_uid ?? "").trim();

  if (!Number.isFinite(landId) || landId <= 0 || !deviceUid) {
    return NextResponse.json({ error: "land_id and device_uid are required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [landResult, deviceResult] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint")
        .eq("id", landId)
        .maybeSingle(),
      supabase
        .from("iot_devices")
        .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
        .eq("device_uid", deviceUid)
        .maybeSingle()
    ]);

    if (landResult.error) throw landResult.error;
    if (deviceResult.error) throw deviceResult.error;

    if (!landResult.data) {
      return NextResponse.json({ error: "Target land was not found" }, { status: 404 });
    }

    if (!deviceResult.data) {
      return NextResponse.json({ error: "ESP32 device was not found. Let it send telemetry once or register it first." }, { status: 404 });
    }

    const previousLandId = deviceResult.data.land_id;
    const { data: device, error: updateError } = await supabase
      .from("iot_devices")
      .update({
        land_id: landId,
        is_active: true
      })
      .eq("id", deviceResult.data.id)
      .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
      .single();

    if (updateError) throw updateError;

    return NextResponse.json({
      land: landResult.data,
      device,
      previousLandId,
      preservedTopics: true,
      note: "Device land binding was moved for operations, while MQTT topics were preserved so the current ESP32 firmware can still receive commands."
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to bind ESP32 device" },
      { status: 500 }
    );
  }
}
