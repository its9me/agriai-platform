import { NextResponse } from "next/server";
import { getGeminiKeyCount } from "@/lib/gemini";

const checks = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
  "OPENWEATHER_API_KEY",
  "MQTT_BROKER_URL",
  "MQTT_USERNAME",
  "MQTT_PASSWORD",
  "IOT_INGEST_TOKEN",
  "AUTOPILOT_CRON_TOKEN"
];

export function GET() {
  let geminiKeyCount = 0;
  try {
    geminiKeyCount = getGeminiKeyCount();
  } catch {
    geminiKeyCount = 0;
  }

  return NextResponse.json({
    configured: Object.fromEntries(
      checks.map((name) => [name, Boolean(process.env[name])])
    ),
    ai: {
      geminiKeyCount,
      loadBalancingReady: geminiKeyCount > 1
    }
  });
}
