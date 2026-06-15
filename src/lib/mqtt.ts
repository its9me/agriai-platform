import mqtt from "mqtt";
import { requireEnv } from "./env";

export type IrrigationCommandPayload = {
  command_id: string;
  land_id: number;
  device_uid: string;
  status: "ON" | "OFF";
  duration_seconds: number;
  issued_at: string;
  reason: string;
  liters_target?: number | null;
  flow_rate_liters_per_minute?: number | null;
  batch?: {
    current: number;
    total: number | null;
  } | null;
  diagnostic?: boolean;
  safety: {
    max_duration_seconds: number;
    require_ack: boolean;
    diagnostic_test?: boolean;
    manual_override?: boolean;
  };
};

export async function publishIrrigationCommand(topic: string, payload: IrrigationCommandPayload) {
  const brokerUrl = requireEnv("MQTT_BROKER_URL");
  const username = requireEnv("MQTT_USERNAME");
  const password = requireEnv("MQTT_PASSWORD");

  const client = mqtt.connect(brokerUrl, {
    username,
    password,
    reconnectPeriod: 0,
    connectTimeout: 10_000
  });

  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });

  await new Promise<void>((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  client.end();
}
