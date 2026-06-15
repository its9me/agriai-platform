import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export async function GET(request: NextRequest) {
  const expectedToken = process.env.IOT_INGEST_TOKEN;
  if (expectedToken) {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const headerToken = request.headers.get("x-iot-token")?.trim();
    if ((bearer || headerToken) !== expectedToken) {
      return NextResponse.json({ error: "Invalid IoT device config token" }, { status: 401 });
    }
  }

  const deviceUid = String(request.nextUrl.searchParams.get("device_uid") ?? "").trim();
  if (!deviceUid) {
    return NextResponse.json({ error: "device_uid is required" }, { status: 400 });
  }

  const supabase = createSupabaseAdmin();
  const { data: device, error } = await supabase
    .from("iot_devices")
    .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at")
    .eq("device_uid", deviceUid)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!device) {
    return NextResponse.json(
      {
        device_uid: deviceUid,
        registered: false,
        message: "Device is not registered yet. Keep the firmware default land until first registration."
      },
      { status: 404 }
    );
  }

  const landId = Number(device.land_id);
  return NextResponse.json({
    registered: true,
    device_uid: device.device_uid,
    land_id: landId,
    mqtt_topic_command: device.mqtt_topic_command || `farms/${landId}/devices/${device.device_uid}/commands`,
    mqtt_topic_ack: device.mqtt_topic_ack || `farms/${landId}/devices/${device.device_uid}/ack`,
    relay_pin: device.relay_pin,
    is_active: device.is_active,
    last_seen_at: device.last_seen_at
  });
}
