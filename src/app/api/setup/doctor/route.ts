import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getGeminiKeyCount } from "@/lib/gemini";

const envChecks = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
  "OPENWEATHER_API_KEY",
  "MQTT_BROKER_URL",
  "MQTT_USERNAME",
  "MQTT_PASSWORD"
];

const tableChecks = [
  "lands",
  "imagery",
  "ai_analyses",
  "irrigation_recommendations",
  "iot_devices",
  "iot_commands",
  "field_notes",
  "ai_action_plans",
  "ai_decisions",
  "iot_telemetry"
];

function tableFix(table: string) {
  if (table === "iot_telemetry") {
    return "شغّل ملف outputs/iot_telemetry_schema.sql من Supabase SQL Editor.";
  }

  if (table === "ai_decisions") {
    return "شغّل ملف outputs/ai_decisions_schema.sql من Supabase SQL Editor حتى يتم حفظ قرارات AI كسجل تدقيق.";
  }

  if (table === "field_notes" || table === "ai_action_plans" || table === "ai_decisions") {
    return "شغّل آخر نسخة من supabase/schema.sql أو مقطع الجداول الإضافية داخل Supabase SQL Editor.";
  }

  return "شغّل supabase/schema.sql داخل Supabase SQL Editor.";
}

export async function GET() {
  try {
    let geminiKeyCount = 0;
    try {
      geminiKeyCount = getGeminiKeyCount();
    } catch {
      geminiKeyCount = 0;
    }

    const env = Object.fromEntries(
      envChecks.map((name) => [
        name,
        {
          ready: Boolean(process.env[name]),
          fix: Boolean(process.env[name]) ? null : `أضف ${name} إلى .env.local أو إعدادات Vercel.`
        }
      ])
    );

    const supabase = createSupabaseAdmin();
    const tableResults = await Promise.all(
      tableChecks.map(async (table) => {
        const { error } = await supabase.from(table).select("id").limit(1);
        return [
          table,
          {
            ready: !error,
            error: error?.message ?? null,
            fix: error ? tableFix(table) : null
          }
        ] as const;
      })
    );

    const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
    const hasImageryBucket = Boolean(buckets?.some((bucket) => bucket.name === "imagery"));
    const storage = {
      imagery: {
        ready: hasImageryBucket,
        error: bucketError?.message ?? null,
        fix: hasImageryBucket
          ? null
          : "ارفع صورة تحليل واحدة لأرض محفوظة أو أنشئ bucket باسم imagery في Supabase Storage."
      }
    };

    const envValues = Object.values(env);
    const tableValues = tableResults.map(([, value]) => value);
    const storageValues = Object.values(storage);
    const missing = [
      ...Object.entries(env)
        .filter(([, value]) => !value.ready)
        .map(([name, value]) => ({ type: "env", name, fix: value.fix })),
      ...tableResults
        .filter(([, value]) => !value.ready)
        .map(([name, value]) => ({ type: "table", name, fix: value.fix })),
      ...Object.entries(storage)
        .filter(([, value]) => !value.ready)
        .map(([name, value]) => ({ type: "storage", name, fix: value.fix }))
    ];

    return NextResponse.json({
      score: Math.round(
        ((envValues.filter((item) => item.ready).length +
          tableValues.filter((item) => item.ready).length +
          storageValues.filter((item) => item.ready).length) /
          (envValues.length + tableValues.length + storageValues.length)) *
          100
      ),
      env,
      ai: {
        geminiKeyCount,
        loadBalancingReady: geminiKeyCount > 1,
        fix: geminiKeyCount > 1
          ? null
          : "أضف GEMINI_API_KEY_2 أو GEMINI_API_KEYS حتى يتم تدوير مفاتيح Gemini عند الضغط."
      },
      tables: Object.fromEntries(tableResults),
      storage,
      missing
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Setup doctor failed" },
      { status: 500 }
    );
  }
}
