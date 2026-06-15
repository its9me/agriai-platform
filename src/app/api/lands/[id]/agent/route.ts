import { NextRequest, NextResponse } from "next/server";
import { runLandOperationsAgent } from "@/lib/gemini";
import { calculateIrrigation } from "@/lib/irrigation";
import { buildPottedCommandPreview } from "@/lib/potted-plants";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function aggregatePlantsByName(analyses: any[]) {
  const groups = new Map<string, { name: string; count: number }>();

  for (const analysis of analyses) {
    const plants = Array.isArray(analysis.plant_summary?.plants)
      ? analysis.plant_summary.plants
      : [];

    for (const plant of plants) {
      const name = String(plant.name ?? "unknown").trim();
      const key = name.toLowerCase();
      const count = Math.max(0, Number(plant.count ?? 0));
      const current = groups.get(key);
      groups.set(key, {
        name,
        count: Math.max(current?.count ?? 0, count)
      });
    }
  }

  return Array.from(groups.values());
}

function manualPlants(plants: any[]) {
  return plants.map((plant) => ({
    name: String(plant.name ?? "unknown"),
    count: Math.max(0, Number(plant.count ?? 0)),
    source: "manual"
  }));
}

function numberFromPayload(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return null;
  const parsed = Number((payload as Record<string, unknown>)[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPottedIrrigationFromPreview(input: {
  preview: any;
  tankAvailableLiters: number | null;
  tankReserveLiters: number;
}) {
  const liters = Math.max(0, Number(input.preview?.liters_target ?? 0));
  const duration = Math.max(0, Math.ceil(Number(input.preview?.duration_seconds ?? 0)));
  const tankAvailableLiters = Number.isFinite(Number(input.tankAvailableLiters))
    ? Math.max(0, Number(input.tankAvailableLiters))
    : null;
  const tankReserveLiters = Math.max(0, Number(input.tankReserveLiters ?? 0));
  const usableTankLiters = tankAvailableLiters === null
    ? null
    : Math.max(0, tankAvailableLiters - tankReserveLiters);
  const executableLiters = usableTankLiters === null ? liters : Math.min(liters, usableTankLiters);
  const tankShortageLiters = usableTankLiters === null ? 0 : Math.max(0, liters - usableTankLiters);
  const flow = Math.max(0.1, Number(input.preview?.flow_rate_liters_per_minute ?? 1) || 1);

  return {
    source: "potted_container_preview",
    calculationMethod: "Potted plant image analysis + ESP32 soil sensor. Open-Meteo soil moisture is ignored for indoor/container plants.",
    totalLitersPerDay: liters,
    totalLitersPerIrrigation: liters,
    executableLiters,
    tankAvailableLiters,
    tankReserveLiters,
    usableTankLiters,
    tankShortageLiters,
    canCompleteIrrigation: tankShortageLiters <= 0.01,
    irrigationIntervalDays: 1,
    recommendedDurationSeconds: duration,
    recommendedIrrigationDurationSeconds: duration,
    flowRateLitersPerMinute: flow,
    waterSavingPercent: 100,
    irrigationMode: "potted_container",
    irrigationModeLabel: "Potted/container sensor mode",
    soilMoisturePercent: input.preview?.soil_moisture_percent ?? null,
    soilMoistureAdjustmentFactor: input.preview?.soil_moisture_adjustment_factor ?? 1,
    rawTotalLitersPerIrrigation: input.preview?.raw_liters_target ?? liters,
    containerSafeCapLiters: input.preview?.container_safe_cap_liters ?? input.preview?.capped_raw_liters_target ?? null,
    cropWaterPlan: [
      {
        name: "potted_plant",
        count: 1,
        unit: "container",
        totalLitersPerIrrigation: liters,
        source: "saved potted plant analysis"
      }
    ]
  };
}

function buildFallbackAgent(input: {
  message: string;
  land: any;
  plants: any[];
  irrigation: any | null;
  weather: any;
  devices: any[];
  telemetry: any[];
  analyses: any[];
  activeDevice: any | null;
  mqttTopic: string;
  aiError: string | null;
}) {
  const pestRisk = String(input.analyses[0]?.pest_summary?.risk_level ?? "unknown").toLowerCase();
  const tankShortage = Number(input.irrigation?.tankShortageLiters ?? 0);
  const intervalDays = Number(input.irrigation?.irrigationIntervalDays ?? 1);
  const hasSoilMoisture = input.telemetry.some((row) => Number.isFinite(Number(row.soil_moisture_percent)));
  const latestSoilMoisture = Number(input.telemetry[0]?.soil_moisture_percent);
  const isPottedTarget = String(input.land?.name ?? "").trim().startsWith("نبات:");
  const durationSeconds = Number(input.irrigation?.recommendedIrrigationDurationSeconds ?? 0);
  const litersTarget = Number(input.irrigation?.executableLiters ?? 0);
  const safeDurationSeconds = Math.min(1800, durationSeconds);
  const durationNeedsSplit = durationSeconds > 1800;
  const safeLitersTarget = durationSeconds > 0 && durationNeedsSplit
    ? litersTarget * (safeDurationSeconds / durationSeconds)
    : litersTarget;
  const canPrepare = Boolean(input.activeDevice && safeDurationSeconds > 0 && tankShortage <= 0 && pestRisk !== "high");
  const needsApproval = intervalDays > 1 && !hasSoilMoisture;

  const decision = !input.plants.length
    ? "collect_data"
    : isPottedTarget && Number.isFinite(latestSoilMoisture) && latestSoilMoisture >= 70
      ? "wait"
    : tankShortage > 0
      ? "refill_tank"
      : !input.activeDevice
        ? "connect_device"
        : pestRisk === "high"
          ? "inspect"
          : canPrepare
            ? "prepare_irrigation"
            : "manual_review";

  return {
    agent_name: "AgriAI Operations Agent",
    intent: input.message,
    decision,
    confidence: canPrepare ? 0.78 : 0.58,
    summary: tankShortage > 0
      ? `الخزان لا يكفي للرية. يوجد نقص ${tankShortage.toFixed(1)} لتر، لذلك لا يتم تجهيز تشغيل تلقائي قبل التعبئة أو اعتماد رية جزئية.`
      : isPottedTarget && Number.isFinite(latestSoilMoisture) && latestSoilMoisture >= 70
        ? `النبات المفرد لا يحتاج ري الآن؛ حساس التربة يقرأ ${latestSoilMoisture.toFixed(0)}% وهي رطوبة عالية، لذلك تم تقديم الحساس على أي بيانات مناخية أو تقدير بصري.`
      : canPrepare
        ? `تم تجهيز قرار ري قابل للمراجعة: ${safeLitersTarget.toFixed(1)} لتر لمدة ${safeDurationSeconds} ثانية${durationNeedsSplit ? " كدفعة أولى لأن الرية الكاملة تتجاوز حد الأمان." : "."}`
        : "الـ Agent يحتاج بيانات أو تحقق إضافي قبل تجهيز أمر ري.",
    tool_trace: [
      { tool: "get_land_state", status: input.land ? "pass" : "fail", result: `الأرض: ${input.land?.name ?? "غير معروفة"}` },
      { tool: "read_plant_inventory", status: input.plants.length ? "pass" : "warning", result: input.plants.length ? input.plants.map((plant) => `${plant.name}: ${plant.count}`).join(" / ") : "لا توجد نباتات معتمدة" },
      { tool: "read_weather", status: input.weather ? "pass" : "warning", result: input.weather ? `مطر متوقع ${Number(input.weather.forecastRainMm ?? 0).toFixed(1)} mm` : "لا توجد قراءة طقس" },
      { tool: "calculate_irrigation", status: input.irrigation ? "pass" : "warning", result: input.irrigation ? `الرية ${Number(input.irrigation.totalLitersPerIrrigation ?? 0).toFixed(1)} L / التنفيذ ${litersTarget.toFixed(1)} L / الدفعة الآمنة ${safeLitersTarget.toFixed(1)} L` : "لا توجد حسابات ري" },
      { tool: "check_tank", status: tankShortage > 0 ? "fail" : "pass", result: tankShortage > 0 ? `نقص ${tankShortage.toFixed(1)} L` : "الخزان يكفي ضمن الاحتياطي" },
      { tool: "check_iot", status: input.activeDevice ? "pass" : "fail", result: input.activeDevice ? `الجهاز الفعال ${input.activeDevice.device_uid}` : "لا يوجد جهاز فعال" },
      { tool: "check_pests", status: pestRisk === "high" ? "fail" : "pass", result: `خطر الآفات: ${pestRisk}` },
      { tool: "prepare_mqtt_command", status: canPrepare ? "pass" : "warning", result: canPrepare ? `Topic ${input.mqttTopic}` : "لم يتم تجهيز أمر قابل للإرسال" }
    ],
    proposed_command: {
      allowed_to_prepare: canPrepare,
      requires_admin_approval: true,
      mqtt_topic: canPrepare ? input.mqttTopic : "",
      payload: {
        land_id: Number(input.land?.id ?? 0),
        device_uid: input.activeDevice?.device_uid ?? "",
        status: canPrepare ? "ON" : "OFF",
        duration_seconds: canPrepare ? safeDurationSeconds : 0,
        liters_target: canPrepare ? safeLitersTarget : 0,
        reason: canPrepare
          ? durationNeedsSplit
            ? "قرار Agent بعد فحص الخزان والطقس والنباتات والجهاز. تم تجهيز دفعة آمنة أولى لأن مدة الرية الكاملة تتجاوز 1800 ثانية."
            : "قرار Agent بعد فحص الخزان والطقس والنباتات والجهاز"
          : "غير مسموح بالتجهيز بسبب شروط أمان غير مكتملة"
      }
    },
    safety_checks: [
      { name: "الخزان", status: tankShortage > 0 ? "fail" : "pass", details: tankShortage > 0 ? `نقص ${tankShortage.toFixed(1)} لتر` : "يكفي للرية المقترحة" },
      { name: "حد مدة التشغيل", status: durationNeedsSplit ? "warning" : "pass", details: durationNeedsSplit ? "الرية الكاملة تتجاوز 1800 ثانية، لذلك تم تجهيز دفعة أولى فقط" : "ضمن حد 1800 ثانية" },
      { name: "الجهاز", status: input.activeDevice ? "pass" : "fail", details: input.activeDevice ? "يوجد ESP32 فعال" : "لا يوجد ESP32 فعال" },
      { name: "الآفات", status: pestRisk === "high" ? "fail" : "pass", details: `آخر خطر آفات: ${pestRisk}` },
      { name: "فاصل الري", status: needsApproval ? "warning" : "pass", details: needsApproval ? "يلزم تأكيد آخر سقية أو قراءة رطوبة" : "لا يوجد مانع من الفاصل" }
    ],
    next_actions: [
      tankShortage > 0 ? { owner: "operator", action: "تعبئة الخزان أو اعتماد رية جزئية", priority: "high" } : null,
      !input.activeDevice ? { owner: "hardware", action: "ربط ESP32 فعال بالأرض", priority: "high" } : null,
      needsApproval ? { owner: "admin", action: "تأكيد أن الأرض مستحقة للري اليوم", priority: "medium" } : null,
      durationNeedsSplit ? { owner: "admin", action: "تقسيم الرية إلى دفعات ومراقبة الخزان بين الدفعات", priority: "medium" } : null,
      canPrepare ? { owner: "admin", action: "مراجعة الأمر المقترح ثم الإرسال من لوحة الري", priority: "medium" } : null
    ].filter(Boolean),
    missing_data: [
      input.aiError ? "Gemini غير متاح؛ تم استخدام قواعد Agent الاحتياطية" : null,
      !input.plants.length ? "جرد نباتات أو تحليل صور" : null,
      !hasSoilMoisture ? "قراءة رطوبة تربة" : null,
      !input.activeDevice ? "جهاز ESP32 فعال" : null
    ].filter(Boolean)
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const body = await request.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [
      landResult,
      analysesResult,
      plantsResult,
      devicesResult,
      telemetryResult,
      recommendationsResult,
      pottedPlantResult
    ] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,centroid,auto_irrigation_enabled,created_at").eq("id", landId).single(),
      supabase.from("ai_analyses").select("id,plant_summary,pest_summary,confidence,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(12),
      supabase.from("land_plants").select("id,name,count,growth_stage,notes,source,created_at").eq("land_id", landId).order("created_at", { ascending: false }),
      supabase.from("iot_devices").select("id,device_uid,is_active,last_seen_at,mqtt_topic_command").eq("land_id", landId),
      supabase.from("iot_telemetry").select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,flow_liters_per_minute,valve_state,raw_payload,captured_at,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(8),
      supabase.from("irrigation_recommendations").select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,flow_rate_liters_per_minute,status,created_at").eq("land_id", landId).order("created_at", { ascending: false }).limit(5),
      supabase.from("potted_plants").select("id,name,analysis_json,command_preview,flow_rate_liters_per_minute,linked_land_id,updated_at").eq("linked_land_id", landId).order("updated_at", { ascending: false }).limit(1).maybeSingle()
    ]);

    if (landResult.error) throw landResult.error;

    const land = landResult.data;
    const centroid = land?.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0] ?? Number(body.lon);
    const lat = centroid?.coordinates?.[1] ?? Number(body.lat);
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(Number(lat), Number(lon)).catch(() => null)
      : null;

    const analyses = analysesResult.error ? [] : (analysesResult.data ?? []);
    const verifiedPlants = plantsResult.error ? [] : (plantsResult.data ?? []);
    let plants = verifiedPlants.length ? manualPlants(verifiedPlants) : aggregatePlantsByName(analyses);
    const devices = devicesResult.error ? [] : (devicesResult.data ?? []);
    const telemetry = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    const latestTelemetry = telemetry[0] ?? null;
    const activeDevice = devices.find((device) => device.is_active) ?? null;
    const latestRecommendation = recommendationsResult.error ? null : (recommendationsResult.data ?? [])[0] ?? null;
    const pottedPlant = pottedPlantResult.error ? null : pottedPlantResult.data;
    const isPottedTarget = Boolean(pottedPlant) || String(land.name ?? "").trim().startsWith("نبات:");
    if (isPottedTarget && !plants.length) {
      plants = [{ name: pottedPlant?.name ?? land.crop_hint ?? land.name ?? "potted plant", count: 1 }];
    }
    const flowRate = Number(body.flowRateLitersPerMinute ?? latestRecommendation?.flow_rate_liters_per_minute ?? 10);
    const telemetryTankLiters = numberFromPayload(latestTelemetry?.raw_payload, "tank_volume_liters");
    const tankAvailableLiters = Number.isFinite(Number(body.tankAvailableLiters))
      ? Number(body.tankAvailableLiters)
      : Number(telemetryTankLiters);
    const tankReserveLiters = Number(body.tankReserveLiters ?? 0);
    const waterSavingPercent = Number(body.waterSavingPercent ?? 70);
    const irrigationMode = String(body.irrigationMode ?? "medium_productivity");

    const sensorContext = latestTelemetry
      ? {
        soilMoisturePercent: latestTelemetry.soil_moisture_percent,
        tankVolumeLiters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : null,
        capturedAt: latestTelemetry.captured_at ?? latestTelemetry.created_at ?? null,
        deviceUid: latestTelemetry.device_uid ?? null
      }
      : null;
    const pottedPreview = isPottedTarget && pottedPlant?.analysis_json
      ? buildPottedCommandPreview({
        analysis: structuredClone(pottedPlant.analysis_json),
        flowRateLitersPerMinute: Math.max(0.1, Number(flowRate || pottedPlant.flow_rate_liters_per_minute || 1)),
        sensorContext
      })
      : null;

    const irrigation = isPottedTarget && pottedPreview
      ? buildPottedIrrigationFromPreview({
        preview: pottedPreview,
        tankAvailableLiters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : null,
        tankReserveLiters: Number.isFinite(tankReserveLiters) ? tankReserveLiters : 0
      })
      : weather && plants.length
        ? calculateIrrigation({
        plants,
        areaM2: Number(land.area_m2 ?? 0),
        forecastRainMm: Number(weather.forecastRainMm ?? 0),
        flowRateLitersPerMinute: flowRate,
        tankAvailableLiters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : undefined,
        tankReserveLiters: Number.isFinite(tankReserveLiters) ? tankReserveLiters : undefined,
        waterSavingPercent: Number.isFinite(waterSavingPercent) ? waterSavingPercent : undefined,
        irrigationMode,
        agronomicContext: weather.agronomic,
        sensorContext
      })
        : null;

    const mqttTopic = activeDevice?.mqtt_topic_command || `agriai/lands/${landId}/valve/cmd`;
    const fullDurationSeconds = Number(irrigation?.recommendedIrrigationDurationSeconds ?? 0);
    const safeDurationSeconds = Math.min(1800, fullDurationSeconds);
    const safeLitersTarget = fullDurationSeconds > 1800 && fullDurationSeconds > 0
      ? Number(irrigation?.executableLiters ?? 0) * (safeDurationSeconds / fullDurationSeconds)
      : Number(irrigation?.executableLiters ?? 0);
    const toolResults = {
      get_land_state: {
        land,
        target_type: isPottedTarget ? "potted_container" : "field_land",
        potted_plant: pottedPlant
          ? {
            id: pottedPlant.id,
            name: pottedPlant.name,
            linked_land_id: pottedPlant.linked_land_id,
            updated_at: pottedPlant.updated_at
          }
          : null
      },
      read_weather: isPottedTarget
        ? {
          available_for_context_only: Boolean(weather),
          ignored_for_potted_irrigation: true,
          reason: "النبات المفرد/الحوض يعتمد على حساس رطوبة ESP32 وحجم التربة، ولا يستخدم رطوبة Open-Meteo لأنها ليست داخل الحوض."
        }
        : weather,
      read_plant_inventory: { source: verifiedPlants.length ? "manual" : "image_ai", plants },
      calculate_irrigation: isPottedTarget
        ? {
          ...irrigation,
          potted_preview: pottedPreview,
          sensor_priority: "ESP32 soil moisture is authoritative; do not compare it with Open-Meteo soil moisture for this potted plant."
        }
        : irrigation,
      check_tank: irrigation ? {
        available_liters: irrigation.tankAvailableLiters,
        reserve_liters: irrigation.tankReserveLiters,
        usable_liters: irrigation.usableTankLiters,
        shortage_liters: irrigation.tankShortageLiters,
        water_saving_percent: irrigation.waterSavingPercent,
        irrigation_mode: irrigation.irrigationMode,
        irrigation_mode_label: irrigation.irrigationModeLabel,
        can_complete: irrigation.canCompleteIrrigation
      } : null,
      check_iot: { activeDevice, devices, telemetry, latest_sensor_context: sensorContext },
      check_pests: {
        latestRisk: analyses[0]?.pest_summary?.risk_level ?? "unknown",
        latestPestSummary: analyses[0]?.pest_summary ?? null
      },
      prepare_mqtt_command: irrigation && activeDevice ? {
        topic: mqttTopic,
        max_duration_seconds: 1800,
        full_duration_seconds: fullDurationSeconds,
        duration_was_split: fullDurationSeconds > 1800,
        payload: {
          land_id: landId,
          device_uid: activeDevice.device_uid,
          status: "ON",
          duration_seconds: safeDurationSeconds,
          liters_target: safeLitersTarget,
          reason: "Prepared by AgriAI Operations Agent"
        }
      } : null
    };

    let source = "gemini_agent";
    let aiError: string | null = null;
    let agent;

    try {
      agent = await runLandOperationsAgent({
        message,
        context: {
          role: "admin",
          policy: "prepare only; Admin approval is required before MQTT publish",
          targetType: isPottedTarget ? "potted_container" : "field_land",
          moistureAuthority: isPottedTarget
            ? "For this potted/container plant, ESP32 soil moisture is authoritative. Do not treat Open-Meteo soil moisture as conflicting evidence."
            : "Use ESP32 soil moisture as stronger field evidence when available.",
          tankCapacityLiters: Number.isFinite(Number(body.tankCapacityLiters)) ? Number(body.tankCapacityLiters) : null
        },
        toolResults
      });
    } catch (error) {
      source = "rules_agent_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      agent = buildFallbackAgent({
        message,
        land,
        plants,
        irrigation,
        weather,
        devices,
        telemetry,
        analyses,
        activeDevice,
        mqttTopic,
        aiError
      });
    }

    return NextResponse.json({
      agent,
      source,
      aiError,
      toolResults
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent run failed" },
      { status: 500 }
    );
  }
}
