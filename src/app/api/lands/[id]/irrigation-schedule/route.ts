import { NextRequest, NextResponse } from "next/server";
import { generateIrrigationSchedule } from "@/lib/gemini";
import { calculateIrrigation } from "@/lib/irrigation";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function fallbackSchedule(landOps: any, weather: any, aiError: string | null) {
  const latestRecommendation = landOps.recommendations[0];
  const activeDevice = landOps.devices.find((device: any) => device.is_active);
  const latestRisk = landOps.analyses[0]?.pest_summary?.risk_level ?? "unknown";
  const forecastRainMm = Number(weather?.forecastRainMm ?? 0);
  const dailyAverageLiters = Number(latestRecommendation?.daily_average_liters ?? latestRecommendation?.total_liters_per_day ?? 0);
  const litersPerIrrigation = Number(latestRecommendation?.total_liters_per_irrigation ?? latestRecommendation?.liters_per_irrigation ?? dailyAverageLiters);
  const irrigationIntervalDays = Math.max(1, Number(latestRecommendation?.irrigation_interval_days ?? 1));
  const durationSeconds = Number(latestRecommendation?.recommended_irrigation_duration_seconds ?? latestRecommendation?.recommended_duration_seconds ?? 0);
  const tankShortageLiters = Math.max(0, Number(latestRecommendation?.tank_shortage_liters ?? 0));
  const executableLiters = Number(latestRecommendation?.executable_liters ?? litersPerIrrigation);
  const rainDeduction = Number(latestRecommendation?.rain_deduction_liters ?? 0);
  const shouldWaitForRain = forecastRainMm >= 4;
  const pestHold = latestRisk === "high";
  const hasSoilMoisture = landOps.telemetry.some((row: any) => Number.isFinite(Number(row.soil_moisture_percent)));
  const intervalNeedsConfirmation = irrigationIntervalDays > 1 && !hasSoilMoisture;
  const tankHold = tankShortageLiters > 0;
  const canSendMqtt = Boolean(activeDevice && durationSeconds > 0 && !shouldWaitForRain && !pestHold && !intervalNeedsConfirmation && !tankHold);
  const missingData = [
    !latestRecommendation ? "توصية ري حديثة" : null,
    !activeDevice ? "جهاز ESP32 فعّال" : null,
    tankHold ? `الخزان ناقص ${tankShortageLiters.toFixed(1)} لتر عن الرية المطلوبة` : null,
    !landOps.telemetry.length ? "قراءة رطوبة تربة" : null,
    intervalNeedsConfirmation ? "آخر تاريخ سقي أو قراءة رطوبة لتأكيد أن الرية مستحقة اليوم" : null,
    !landOps.analyses.length ? "تحليل صورة حديث" : null,
    aiError ? "Gemini غير متاح حالياً؛ تم استخدام قواعد تشغيلية" : null
  ].filter(Boolean) as string[];

  return {
    title: `جدولة ري ذكية لأرض ${landOps.land?.name ?? "غير مسماة"}`,
    mode: !latestRecommendation
      ? "collect_data"
        : shouldWaitForRain || pestHold || tankHold
        ? "wait"
        : intervalNeedsConfirmation
          ? "manual_approval"
          : canSendMqtt
          ? "auto_ready"
          : "manual_approval",
    confidence: Math.max(0.42, Math.min(0.86, 0.45 + landOps.recommendations.length * 0.08 + landOps.telemetry.length * 0.05 + landOps.analyses.length * 0.05)),
    summary: !latestRecommendation
      ? "لا توجد توصية ري محفوظة بعد، لذلك الأولوية هي تحليل صورة أو توليد توصية ري قبل الجدولة."
      : shouldWaitForRain
        ? `يوجد مطر متوقع ${forecastRainMm.toFixed(1)} mm، لذلك الجدولة تؤجل الري وتطلب مراجعة قبل التشغيل.`
        : pestHold
          ? "خطر الآفات الأخير مرتفع، لذلك يتم إيقاف الري التلقائي لحين الفحص الميداني."
          : tankHold
            ? `الخزان لا يكفي للرية الكاملة. المطلوب ${litersPerIrrigation.toFixed(1)} لتر والمتاح للتنفيذ ${executableLiters.toFixed(1)} لتر، لذلك يلزم تعبئة الخزان أو اعتماد رية جزئية.`
          : intervalNeedsConfirmation
            ? `النباتات لا تحتاج سقاية يومية ثابتة. الخطة الحالية تقترح رية ${litersPerIrrigation.toFixed(1)} لتر كل ${irrigationIntervalDays} أيام، لكن يلزم تأكيد آخر موعد سقي أو قراءة رطوبة قبل التشغيل.`
            : `الخطة تقترح رية ${litersPerIrrigation.toFixed(1)} لتر كل ${irrigationIntervalDays} يوم/أيام بمدة تشغيل ${durationSeconds} ثانية.`,
    water_budget: {
      liters_next_24h: shouldWaitForRain || pestHold || intervalNeedsConfirmation || tankHold ? 0 : executableLiters,
      daily_average_liters: dailyAverageLiters,
      liters_per_irrigation: litersPerIrrigation,
      executable_liters: executableLiters,
      tank_available_liters: latestRecommendation?.tank_available_liters ?? null,
      tank_reserve_liters: latestRecommendation?.tank_reserve_liters ?? 0,
      usable_tank_liters: latestRecommendation?.usable_tank_liters ?? null,
      tank_shortage_liters: tankShortageLiters,
      can_complete_irrigation: !tankHold,
      irrigation_interval_days: irrigationIntervalDays,
      rain_deduction_liters: rainDeduction,
      source_recommendation_id: latestRecommendation?.id ?? 0
    },
    slots: [
      {
        slot: 1,
        start_after_minutes: shouldWaitForRain || pestHold || intervalNeedsConfirmation || tankHold ? 0 : 30,
        duration_seconds: canSendMqtt ? durationSeconds : 0,
        valve_status: canSendMqtt ? "ON" : shouldWaitForRain ? "OFF" : "INSPECT",
        reason: shouldWaitForRain
          ? "المطر المتوقع يكفي لتأجيل الري ومراقبة التربة."
          : pestHold
            ? "فحص الآفات مقدم على تشغيل المياه حتى لا تتفاقم الإصابة."
            : tankHold
              ? "الخزان لا يكفي للرية المطلوبة، لذلك يمنع النظام إرسال أمر MQTT حتى تتم تعبئة الخزان أو اعتماد رية جزئية."
            : intervalNeedsConfirmation
              ? "النباتات لها فاصل ري أكبر من يوم واحد، لذلك يلزم تأكيد آخر سقية أو قراءة رطوبة قبل فتح الصمام."
              : canSendMqtt
              ? "الأرض لديها توصية ري وجهاز فعّال، ويمكن إرسال الأمر بعد موافقة المشغل."
              : "الدليل غير مكتمل للتشغيل الآلي، لذلك يلزم اعتماد يدوي.",
        send_mqtt: canSendMqtt,
        requires_operator_approval: true
      }
    ],
    safety_checks: [
      "تأكد أن الصمام مغلق قبل بدء التنفيذ.",
      "راجع آخر صورة أو ملاحظة ميدانية إذا كان خطر الآفات متوسط أو أعلى.",
      "لا ترسل MQTT إذا لم يظهر الجهاز كفعّال أو لا توجد قراءة ACK."
    ],
    operator_message: canSendMqtt
      ? `بعد الموافقة، يمكن تشغيل الصمام لمدة ${durationSeconds} ثانية.`
      : intervalNeedsConfirmation
        ? "لا ترسل أمر ري الآن. أكد آخر تاريخ سقي أو أضف قراءة رطوبة تربة، لأن النبات لا يحتاج تشغيل يومي تلقائي."
        : tankHold
          ? "لا ترسل أمر ري الآن. عبئ الخزان أو خفّض كمية الرية واعتمد خطة جزئية."
        : "لا ترسل أمر ري تلقائي الآن؛ أكمل الفحص أو البيانات الناقصة أولاً.",
    manager_value: "تحويل توصية الري إلى جدول تنفيذ واضح يقلل القرارات اليدوية ويعطي الحكام دليلاً على قابلية التشغيل اليومي.",
    missing_data: missingData
  };
}

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
    name: plant.name,
    count: Number(plant.count ?? 0),
    source: "manual"
  }));
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);
  const body = await request.json().catch(() => ({}));

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [
      landResult,
      recommendationsResult,
      analysesResult,
      devicesResult,
      telemetryResult,
      decisionsResult,
      commandsResult,
      plantsResult
    ] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,centroid,created_at")
        .eq("id", landId)
        .single(),
      supabase
        .from("irrigation_recommendations")
        .select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,flow_rate_liters_per_minute,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(6),
      supabase
        .from("ai_analyses")
        .select("id,plant_summary,pest_summary,confidence,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("iot_devices")
        .select("id,device_uid,is_active,last_seen_at")
        .eq("land_id", landId),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,flow_liters_per_minute,valve_state,battery_percent,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("ai_decisions")
        .select("id,decision_json,evidence_counts,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("iot_commands")
        .select("id,status,payload,ack_payload,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("land_plants")
        .select("id,name,count,growth_stage,notes,source,created_at,updated_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
    ]);

    for (const result of [landResult, recommendationsResult, analysesResult, devicesResult, commandsResult]) {
      if (result.error) throw result.error;
    }

    const centroid = landResult.data?.centroid as { coordinates?: [number, number] } | null;
    const lon = centroid?.coordinates?.[0] ?? Number(body.lon);
    const lat = centroid?.coordinates?.[1] ?? Number(body.lat);
    const weather = Number.isFinite(lat) && Number.isFinite(lon)
      ? await getWeather(lat, lon)
      : null;

    const verifiedPlants = plantsResult.error ? [] : (plantsResult.data ?? []);
    const consensusPlants = verifiedPlants.length ? manualPlants(verifiedPlants) : aggregatePlantsByName(analysesResult.data ?? []);
    const flowRateLitersPerMinute = Number(body.flowRateLitersPerMinute ?? recommendationsResult.data?.[0]?.flow_rate_liters_per_minute ?? 10);
    const waterSavingPercent = Number(body.waterSavingPercent ?? 70);
    const irrigationMode = String(body.irrigationMode ?? "medium_productivity");
    const consensusIrrigation = weather && consensusPlants.length
      ? calculateIrrigation({
        plants: consensusPlants,
        areaM2: Number(landResult.data?.area_m2 ?? 0),
        forecastRainMm: Number(weather.forecastRainMm ?? 0),
        flowRateLitersPerMinute,
        tankAvailableLiters: Number.isFinite(Number(body.tankAvailableLiters)) ? Number(body.tankAvailableLiters) : undefined,
        tankReserveLiters: Number.isFinite(Number(body.tankReserveLiters)) ? Number(body.tankReserveLiters) : undefined,
        waterSavingPercent: Number.isFinite(waterSavingPercent) ? waterSavingPercent : undefined,
        irrigationMode,
        agronomicContext: weather.agronomic
      })
      : null;
    const consensusRecommendation = consensusIrrigation
      ? {
        id: 0,
        total_liters_per_day: consensusIrrigation.totalLitersPerDay,
        daily_average_liters: consensusIrrigation.dailyAverageLiters,
        total_liters_per_irrigation: consensusIrrigation.totalLitersPerIrrigation,
        liters_per_irrigation: consensusIrrigation.totalLitersPerIrrigation,
        executable_liters: consensusIrrigation.executableLiters,
        tank_available_liters: consensusIrrigation.tankAvailableLiters,
        tank_reserve_liters: consensusIrrigation.tankReserveLiters,
        usable_tank_liters: consensusIrrigation.usableTankLiters,
        tank_shortage_liters: consensusIrrigation.tankShortageLiters,
        can_complete_irrigation: consensusIrrigation.canCompleteIrrigation,
        irrigation_interval_days: consensusIrrigation.irrigationIntervalDays,
        rain_deduction_liters: consensusIrrigation.rainDeductionLiters,
        recommended_duration_seconds: consensusIrrigation.recommendedIrrigationDurationSeconds,
        recommended_irrigation_duration_seconds: consensusIrrigation.recommendedIrrigationDurationSeconds,
        flow_rate_liters_per_minute: flowRateLitersPerMinute,
        raw_total_liters_per_irrigation: consensusIrrigation.rawTotalLitersPerIrrigation,
        water_saving_percent: consensusIrrigation.waterSavingPercent,
        irrigation_mode: consensusIrrigation.irrigationMode,
        irrigation_mode_label: consensusIrrigation.irrigationModeLabel,
        status: "consensus_from_all_unique_images",
        created_at: new Date().toISOString(),
        source: verifiedPlants.length ? "manual_land_inventory" : "deduped_land_memory",
        aggregate_plants: consensusPlants,
        crop_water_plan: consensusIrrigation.cropWaterPlan
      }
      : null;

    const landOps = {
      land: landResult.data,
      recommendations: consensusRecommendation
        ? [consensusRecommendation, ...(recommendationsResult.data ?? [])]
        : recommendationsResult.data ?? [],
      analyses: analysesResult.data ?? [],
      devices: devicesResult.data ?? [],
      telemetry: telemetryResult.error ? [] : (telemetryResult.data ?? []),
      decisions: decisionsResult.error ? [] : (decisionsResult.data ?? []),
      commands: commandsResult.data ?? []
    };

    const evidenceCounts = {
      recommendations: landOps.recommendations.length,
      analyses: landOps.analyses.length,
      devices: landOps.devices.length,
      telemetry: landOps.telemetry.length,
      decisions: landOps.decisions.length,
      commands: landOps.commands.length
    };

    let source = "ai";
    let aiError: string | null = null;
    let schedule;

    try {
      schedule = await generateIrrigationSchedule({
        landOps,
        weather,
        projectContext: {
          hasMqttConfiguration: Boolean(process.env.MQTT_BROKER_URL && process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD),
          requiredOutput: "next 24 hour executable schedule",
          plantCountingPolicy: verifiedPlants.length
            ? "Use recommendations[0]. It is derived from the admin verified manual plant inventory, so image-based conflicting counts are historical evidence only."
            : "Use recommendations[0] when its status is consensus_from_all_unique_images. It is derived from all image analyses after de-duplicating plants by plant name and taking the maximum observed count, so older conflicting recommendations are historical evidence only.",
          verifiedPlants,
          consensusPlants,
          tank: {
            capacityLiters: Number.isFinite(Number(body.tankCapacityLiters)) ? Number(body.tankCapacityLiters) : null,
            availableLiters: Number.isFinite(Number(body.tankAvailableLiters)) ? Number(body.tankAvailableLiters) : null,
            reserveLiters: Number.isFinite(Number(body.tankReserveLiters)) ? Number(body.tankReserveLiters) : null,
            usableLiters: consensusIrrigation?.usableTankLiters ?? null,
            shortageLiters: consensusIrrigation?.tankShortageLiters ?? 0,
            waterSavingPercent: consensusIrrigation?.waterSavingPercent ?? Math.max(40, Math.min(100, Number.isFinite(waterSavingPercent) ? waterSavingPercent : 70))
          }
        }
      });
    } catch (error) {
      source = "rules_fallback";
      aiError = error instanceof Error ? error.message : "Gemini unavailable";
      schedule = fallbackSchedule(landOps, weather, aiError);
    }

    if (consensusRecommendation) {
      const intervalDays = Number(consensusRecommendation.irrigation_interval_days ?? 1);
      const litersPerIrrigation = Number(consensusRecommendation.total_liters_per_irrigation ?? 0);
      const executableLiters = Number(consensusRecommendation.executable_liters ?? litersPerIrrigation);
      const tankShortageLiters = Math.max(0, Number(consensusRecommendation.tank_shortage_liters ?? 0));
      const hasSoilMoisture = landOps.telemetry.some((row: any) => Number.isFinite(Number(row.soil_moisture_percent)));
      const mustConfirmInterval = intervalDays > 1 && !hasSoilMoisture;
      const tankHold = tankShortageLiters > 0;

      schedule.water_budget = {
        ...(schedule.water_budget ?? {}),
        daily_average_liters: Number(consensusRecommendation.daily_average_liters ?? consensusRecommendation.total_liters_per_day ?? 0),
        liters_per_irrigation: litersPerIrrigation,
        executable_liters: executableLiters,
        tank_available_liters: consensusRecommendation.tank_available_liters,
        tank_reserve_liters: consensusRecommendation.tank_reserve_liters,
        usable_tank_liters: consensusRecommendation.usable_tank_liters,
        tank_shortage_liters: tankShortageLiters,
        can_complete_irrigation: !tankHold,
        irrigation_interval_days: intervalDays,
        irrigation_mode: consensusRecommendation.irrigation_mode,
        irrigation_mode_label: consensusRecommendation.irrigation_mode_label,
        rain_deduction_liters: Number(consensusRecommendation.rain_deduction_liters ?? 0),
        source_recommendation_id: schedule.water_budget?.source_recommendation_id ?? 0,
        liters_next_24h: mustConfirmInterval || tankHold ? 0 : Number(schedule.water_budget?.liters_next_24h ?? executableLiters)
      };

      if (mustConfirmInterval || tankHold) {
        schedule.mode = schedule.mode === "auto_ready" ? "manual_approval" : schedule.mode;
        schedule.summary = tankHold
          ? `الخزان لا يكفي للرية الكاملة. المطلوب ${litersPerIrrigation.toFixed(1)} لتر والمتاح ${executableLiters.toFixed(1)} لتر بعد الاحتياطي، لذلك يلزم تعبئة الخزان أو اعتماد رية جزئية قبل فتح الصمام.`
          : `النباتات لا تحتاج سقاية يومية ثابتة. الرية المقترحة ${litersPerIrrigation.toFixed(1)} لتر كل ${intervalDays} أيام، ويلزم تأكيد آخر سقية أو قراءة رطوبة قبل فتح الصمام.`;
        schedule.slots = Array.isArray(schedule.slots) && schedule.slots.length
          ? schedule.slots.map((slot: any) => ({
            ...slot,
            duration_seconds: 0,
            valve_status: "INSPECT",
            send_mqtt: false,
            requires_operator_approval: true,
            reason: tankHold
              ? "الخزان لا يكفي للرية المطلوبة، لذلك يمنع النظام إرسال MQTT حتى تتم تعبئة الخزان أو اعتماد رية جزئية."
              : "تأكيد آخر سقية أو قراءة رطوبة مطلوب قبل تنفيذ الري لأن فاصل المحصول أكبر من يوم واحد."
          }))
          : [{
            slot: 1,
            start_after_minutes: 0,
            duration_seconds: 0,
            valve_status: "INSPECT",
            reason: tankHold
              ? "الخزان لا يكفي للرية المطلوبة، لذلك يمنع النظام إرسال MQTT حتى تتم تعبئة الخزان أو اعتماد رية جزئية."
              : "تأكيد آخر سقية أو قراءة رطوبة مطلوب قبل تنفيذ الري لأن فاصل المحصول أكبر من يوم واحد.",
            send_mqtt: false,
            requires_operator_approval: true
          }];
      }
    }

    const { data: savedSchedule, error: saveError } = await supabase
      .from("irrigation_schedules")
      .insert({
        land_id: landId,
        schedule_json: schedule,
        evidence_counts: evidenceCounts,
        weather_snapshot: weather,
        source,
        status: "draft"
      })
      .select("id")
      .single();

    return NextResponse.json({
      schedule,
      source,
      aiError,
      weather,
      evidenceCounts,
      saved: saveError ? null : { scheduleId: savedSchedule?.id ?? null },
      saveError: saveError
        ? "شغّل outputs/irrigation_schedules_schema.sql في Supabase SQL Editor حتى يتم حفظ جدولات الري."
        : null
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Irrigation schedule failed" },
      { status: 500 }
    );
  }
}
