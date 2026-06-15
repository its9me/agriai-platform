import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

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

function buildAccessories(body: Record<string, unknown>) {
  return {
    has_soil_moisture_sensor: Boolean(body.has_soil_moisture_sensor ?? true),
    has_tank_level_sensor: Boolean(body.has_tank_level_sensor ?? true),
    has_relay: Boolean(body.has_relay ?? true),
    has_pump: Boolean(body.has_pump ?? true),
    has_flow_meter: Boolean(body.has_flow_meter ?? false),
    soil_sensor_model: String(body.soil_sensor_model ?? "HW-030").trim(),
    tank_sensor_model: String(body.tank_sensor_model ?? "HW-038").trim(),
    relay_model: String(body.relay_model ?? "5V relay module").trim(),
    pump_model: String(body.pump_model ?? "USB pump").trim(),
    pump_flow_liters_per_minute: Math.max(0.1, Number(body.pump_flow_liters_per_minute ?? 1) || 1),
    notes: String(body.notes ?? "").trim()
  };
}

export async function GET() {
  try {
    const supabase = createSupabaseAdmin();
    let devicesResult: any = await supabase
      .from("iot_devices")
      .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at,hardware_profile,pump_flow_liters_per_minute,soil_sensor_model,tank_sensor_model,relay_model,pump_model,notes")
      .order("last_seen_at", { ascending: false, nullsFirst: false });

    if (devicesResult.error) {
      devicesResult = await supabase
        .from("iot_devices")
        .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
        .order("last_seen_at", { ascending: false, nullsFirst: false });
    }

    const [telemetryResult, landsResult] = await Promise.all([
      supabase
        .from("iot_telemetry")
        .select("id,land_id,device_uid,soil_moisture_percent,flow_liters_per_minute,tank_level_percent,tank_volume_liters,valve_state,captured_at,created_at")
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("lands").select("id,name,crop_hint")
    ]);

    if (devicesResult.error) throw devicesResult.error;

    const telemetryRows = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    const latestTelemetryByDevice = new Map<string, (typeof telemetryRows)[number]>();
    for (const reading of telemetryRows) {
      if (!latestTelemetryByDevice.has(reading.device_uid)) {
        latestTelemetryByDevice.set(reading.device_uid, reading);
      }
    }

    const landsById = new Map((landsResult.data ?? []).map((land) => [land.id, land]));
    const devices = (devicesResult.data ?? []).map((device: any) => {
      const latestTelemetry = latestTelemetryByDevice.get(device.device_uid) ?? null;
      const lastSeenAt = device.last_seen_at ?? latestTelemetry?.captured_at ?? null;
      const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
      const online = Boolean(
        device.is_active &&
        Number.isFinite(lastSeenMs) &&
        Date.now() - lastSeenMs <= DEVICE_ONLINE_WINDOW_MS
      );
      const land = landsById.get(device.land_id) ?? null;

      return {
        ...device,
        land,
        latestTelemetry,
        connection_status: online ? "online" : "offline",
        can_be_reused_for_selected_land: true
      };
    });

    return NextResponse.json({ devices });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load IoT devices" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const landId = Number(body.land_id);

  if (!Number.isFinite(landId) || landId <= 0) {
    return NextResponse.json({ error: "land_id is required to register ESP32" }, { status: 400 });
  }

  const deviceUid = normalizeDeviceUid(body.device_uid, landId);
  if (!deviceUid) {
    return NextResponse.json({ error: "device_uid is invalid" }, { status: 400 });
  }

  const relayPin = Number.isFinite(Number(body.relay_pin)) ? Number(body.relay_pin) : 26;
  const accessories = buildAccessories(body);
  const mqttTopicCommand = `farms/${landId}/devices/${deviceUid}/commands`;
  const mqttTopicAck = `farms/${landId}/devices/${deviceUid}/ack`;

  try {
    const supabase = createSupabaseAdmin();
    const { data: land, error: landError } = await supabase
      .from("lands")
      .select("id,name,crop_hint")
      .eq("id", landId)
      .maybeSingle();

    if (landError) throw landError;
    if (!land) return NextResponse.json({ error: "Target land was not found" }, { status: 404 });

    const { data: existingDevice, error: existingDeviceError } = await supabase
      .from("iot_devices")
      .select("id,land_id,device_uid")
      .eq("device_uid", deviceUid)
      .maybeSingle();

    if (existingDeviceError) throw existingDeviceError;

    const basePayload = {
      land_id: landId,
      device_uid: deviceUid,
      mqtt_topic_command: mqttTopicCommand,
      mqtt_topic_ack: mqttTopicAck,
      relay_pin: relayPin,
      is_active: true
    };

    const deviceResult = existingDevice
      ? await supabase
          .from("iot_devices")
          .update(basePayload)
          .eq("id", existingDevice.id)
          .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
          .single()
      : await supabase
          .from("iot_devices")
          .insert(basePayload)
          .select("id,land_id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
          .single();

    if (deviceResult.error) throw deviceResult.error;

    let accessoriesPersisted = false;
    const accessoryUpdate = await supabase
      .from("iot_devices")
      .update({
        hardware_profile: accessories,
        pump_flow_liters_per_minute: accessories.pump_flow_liters_per_minute,
        soil_sensor_model: accessories.soil_sensor_model || null,
        tank_sensor_model: accessories.tank_sensor_model || null,
        relay_model: accessories.relay_model || null,
        pump_model: accessories.pump_model || null,
        notes: accessories.notes || null,
        updated_at: new Date().toISOString()
      })
      .eq("id", deviceResult.data.id);

    accessoriesPersisted = !accessoryUpdate.error;

    const platformBaseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://YOUR_VERCEL_DOMAIN";
    const firmwareConfig = [
      `const int LAND_ID = ${landId};`,
      `const char* DEVICE_UID = "${deviceUid}";`,
      `const int RELAY_PIN = ${relayPin};`,
      `const float DEFAULT_FLOW_LITERS_PER_MINUTE = ${accessories.pump_flow_liters_per_minute};`,
      `const char* COMMAND_TOPIC = "${mqttTopicCommand}";`,
      `const char* ACK_TOPIC = "${mqttTopicAck}";`,
      `const char* PLATFORM_TELEMETRY_URL = "${platformBaseUrl}/api/iot/telemetry";`,
      `const char* PLATFORM_ACK_URL = "${platformBaseUrl}/api/iot/ack";`
    ].join("\n");

    return NextResponse.json({
      land,
      device: deviceResult.data,
      accessories,
      accessoriesPersisted,
      topics: {
        command: mqttTopicCommand,
        ack: mqttTopicAck,
        telemetryEndpoint: `${platformBaseUrl}/api/iot/telemetry`,
        ackEndpoint: `${platformBaseUrl}/api/iot/ack`
      },
      firmwareConfig,
      wasExisting: Boolean(existingDevice),
      mqttConfigured: Boolean(process.env.MQTT_BROKER_URL && process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to register ESP32 device" },
      { status: 500 }
    );
  }
}
