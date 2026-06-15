import { NextResponse } from "next/server";
import { generateHardwareReadiness } from "@/lib/gemini";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function fallbackReadiness(hardwareState: any, aiError: string | null) {
  const devices = hardwareState.devices ?? [];
  const commands = hardwareState.commands ?? [];
  const telemetry = hardwareState.telemetry ?? [];
  const activeDevices = devices.filter((device: any) => device.is_active);
  const latestCommand = commands[0];
  const hasAck = Boolean(latestCommand?.ack_payload || latestCommand?.acknowledged_at);
  const mqttConfigured = Boolean(hardwareState.configuration?.mqttConfigured);
  const hasTelemetry = telemetry.length > 0;
  const score = Math.min(100,
    (activeDevices.length ? 30 : 0) +
    (mqttConfigured ? 25 : 0) +
    (commands.length ? 15 : 0) +
    (hasAck ? 15 : 0) +
    (hasTelemetry ? 15 : 0)
  );

  const readiness = score >= 80 ? "ready" : score >= 45 ? "partial" : "not_ready";
  const missingData = [
    !activeDevices.length ? "جهاز ESP32 فعّال" : null,
    !mqttConfigured ? "إعدادات HiveMQ/MQTT في .env.local أو Vercel" : null,
    !commands.length ? "أمر MQTT منشور أو محفوظ" : null,
    !hasAck ? "ACK راجع من ESP32" : null,
    !hasTelemetry ? "قراءة telemetry من ESP32" : null,
    aiError ? "Gemini غير متاح حالياً؛ تم استخدام تقييم قواعدي" : null
  ].filter(Boolean) as string[];

  return {
    headline: `جاهزية عتاد الري لأرض ${hardwareState.land?.name ?? "غير مسماة"}`,
    readiness,
    score,
    operator_summary: readiness === "ready"
      ? "العتاد يملك أدلة كافية لعرض حي مضبوط مع موافقة المشغل."
      : "العتاد يحتاج إكمال بعض الأدلة قبل العرض الحي أو التشغيل الميداني.",
    checks: [
      {
        name: "تسجيل الجهاز",
        status: activeDevices.length ? "pass" : "fail",
        evidence: activeDevices.length ? `${activeDevices.length} جهاز فعّال محفوظ` : "لا يوجد جهاز فعّال محفوظ",
        fix: activeDevices.length ? "لا إجراء" : "استخدم زر تجهيز ESP32 وسجل Device UID"
      },
      {
        name: "إعداد MQTT",
        status: mqttConfigured ? "pass" : "fail",
        evidence: mqttConfigured ? "متغيرات MQTT موجودة" : "MQTT_BROKER_URL أو username/password ناقصة",
        fix: mqttConfigured ? "لا إجراء" : "أضف بيانات HiveMQ المجانية في .env.local أو Vercel"
      },
      {
        name: "ACK من الجهاز",
        status: hasAck ? "pass" : "warning",
        evidence: hasAck ? "يوجد ACK محفوظ لآخر أمر" : "لا يوجد ACK راجع بعد",
        fix: hasAck ? "لا إجراء" : "شغّل ESP32 وتأكد أنه يستدعي /api/iot/ack"
      },
      {
        name: "Telemetry",
        status: hasTelemetry ? "pass" : "warning",
        evidence: hasTelemetry ? `${telemetry.length} قراءة حساسات محفوظة` : "لا توجد قراءة telemetry",
        fix: hasTelemetry ? "لا إجراء" : "شغّل ESP32 وتأكد أنه يرسل /api/iot/telemetry"
      }
    ],
    safe_demo_action: {
      allowed: Boolean(activeDevices.length && mqttConfigured),
      action: activeDevices.length && mqttConfigured ? "نفذ أمر قصير جداً بعد موافقة المشغل" : "اعرض التسجيل والمواضيع بدون تشغيل الصمام",
      reason: activeDevices.length && mqttConfigured
        ? "يوجد جهاز وإعداد MQTT، لكن يفضل انتظار ACK/telemetry قبل تشغيل طويل."
        : "الجهاز أو MQTT غير مكتمل، لذلك التشغيل الحي غير آمن للعرض."
    },
    next_steps: missingData.slice(0, 5),
    manager_value: "هذا الفحص يحول الأتمتة من ادعاء إلى قائمة أدلة تشغيلية يمكن للحكام مراجعتها.",
    missing_data: missingData
  };
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [landResult, devicesResult, commandsResult, telemetryResult] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,created_at")
        .eq("id", landId)
        .single(),
      supabase
        .from("iot_devices")
        .select("id,device_uid,mqtt_topic_command,mqtt_topic_ack,relay_pin,is_active,last_seen_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false }),
      supabase
        .from("iot_commands")
        .select("id,status,payload,published_at,acknowledged_at,ack_payload,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,flow_liters_per_minute,valve_state,battery_percent,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8)
    ]);

    for (const result of [landResult, devicesResult, commandsResult]) {
      if (result.error) throw result.error;
    }

    const hardwareState = {
      generatedAt: new Date().toISOString(),
      land: landResult.data,
      devices: devicesResult.data ?? [],
      commands: commandsResult.data ?? [],
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      configuration: {
        mqttConfigured: Boolean(process.env.MQTT_BROKER_URL && process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD),
        telemetryTableReady: !telemetryResult.error
      }
    };

    let source = "gemini";
    let aiError: string | null = null;
    let readiness;

    try {
      readiness = await generateHardwareReadiness({ hardwareState });
    } catch (error) {
      source = "rules_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      readiness = fallbackReadiness(hardwareState, aiError);
    }

    return NextResponse.json({
      readiness,
      source,
      aiError,
      evidenceCounts: {
        devices: hardwareState.devices.length,
        commands: hardwareState.commands.length,
        telemetry: hardwareState.telemetry.length
      },
      configuration: hardwareState.configuration
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Hardware readiness failed" },
      { status: 500 }
    );
  }
}
