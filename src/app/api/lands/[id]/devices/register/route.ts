import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function normalizeDeviceUid(input: unknown, landId: number) {
  const raw = String(input ?? "").trim();
  if (raw) {
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  return `esp32-land-${landId}-valve-${Date.now().toString(36)}`;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const body = await request.json().catch(() => ({}));

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  const deviceUid = normalizeDeviceUid(body.device_uid, landId);
  if (!deviceUid) {
    return NextResponse.json({ error: "device_uid is invalid" }, { status: 400 });
  }

  const relayPin = Number.isFinite(Number(body.relay_pin)) ? Number(body.relay_pin) : 26;
  const mqttTopicCommand = `farms/${landId}/devices/${deviceUid}/commands`;
  const mqttTopicAck = `farms/${landId}/devices/${deviceUid}/ack`;

  try {
    const supabase = createSupabaseAdmin();
    const { data: land, error: landError } = await supabase
      .from("lands")
      .select("id,name,crop_hint")
      .eq("id", landId)
      .single();

    if (landError) {
      return NextResponse.json({ error: landError.message }, { status: 404 });
    }

    const { data: existingDevice, error: existingDeviceError } = await supabase
      .from("iot_devices")
      .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
      .eq("device_uid", deviceUid)
      .maybeSingle();

    if (existingDeviceError) {
      return NextResponse.json({ error: existingDeviceError.message }, { status: 500 });
    }

    const deviceResult = existingDevice
      ? await supabase
          .from("iot_devices")
          .update({
            relay_pin: relayPin,
            is_active: true
          })
          .eq("id", existingDevice.id)
          .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
          .single()
      : await supabase
          .from("iot_devices")
          .insert({
            land_id: landId,
            device_uid: deviceUid,
            mqtt_topic_command: mqttTopicCommand,
            mqtt_topic_ack: mqttTopicAck,
            relay_pin: relayPin,
            is_active: true
          })
          .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
          .single();

    const { data: device, error: deviceError } = deviceResult;

    if (deviceError) {
      return NextResponse.json({ error: deviceError.message }, { status: 500 });
    }

    const platformBaseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://YOUR_VERCEL_DOMAIN";
    const deviceCommandTopic = device.mqtt_topic_command || mqttTopicCommand;
    const deviceAckTopic = device.mqtt_topic_ack || mqttTopicAck;
    const firmwareConfig = [
      `const char* DEVICE_UID = "${deviceUid}";`,
      `const int LAND_ID = ${device.land_id};`,
      `const char* PLATFORM_TELEMETRY_URL = "${platformBaseUrl}/api/iot/telemetry";`,
      `const char* PLATFORM_ACK_URL = "${platformBaseUrl}/api/iot/ack";`,
      `const char* COMMAND_TOPIC = "${deviceCommandTopic}";`,
      `const char* ACK_TOPIC = "${deviceAckTopic}";`,
      `const int RELAY_PIN = ${relayPin};`
    ].join("\n");

    return NextResponse.json({
      land,
      device,
      topics: {
        command: deviceCommandTopic,
        ack: deviceAckTopic,
        telemetryEndpoint: `${platformBaseUrl}/api/iot/telemetry`,
        ackEndpoint: `${platformBaseUrl}/api/iot/ack`
      },
      firmwareConfig,
      sharedDevice: Boolean(existingDevice && existingDevice.land_id !== landId),
      mqttConfigured: Boolean(process.env.MQTT_BROKER_URL && process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Device registration failed" },
      { status: 500 }
    );
  }
}
