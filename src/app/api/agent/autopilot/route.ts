import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { reviewIrrigationCommandSafety } from "@/lib/gemini";
import { calculateIrrigation } from "@/lib/irrigation";
import { publishIrrigationCommand } from "@/lib/mqtt";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

function aggregatePlantsByName(analyses: any[]) {
  const groups = new Map<string, { name: string; count: number }>();

  for (const analysis of analyses) {
    const plants = Array.isArray(analysis.plant_summary?.plants)
      ? analysis.plant_summary.plants
      : [];

    for (const plant of plants) {
      const name = String(plant.name ?? "unknown").trim();
      if (!name) continue;
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
    count: Math.max(0, Number(plant.count ?? 0))
  }));
}

function riskRank(value: unknown) {
  const risk = String(value ?? "unknown").toLowerCase();
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function numberFromPayload(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return null;
  const parsed = Number((payload as Record<string, unknown>)[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestTankReading(telemetry: any[], fallbackCapacityLiters: number) {
  for (const row of telemetry) {
    const payload = row.raw_payload ?? {};
    if (
      payload &&
      typeof payload === "object" &&
      payload.test_mode === true &&
      payload.tank_sensor_source === undefined
    ) {
      continue;
    }

    const volume = numberFromPayload(payload, "tank_volume_liters");
    const level = numberFromPayload(payload, "tank_level_percent");
    const payloadCapacity = numberFromPayload(payload, "tank_capacity_liters");
    const capacity = payloadCapacity ?? (Number.isFinite(fallbackCapacityLiters) ? fallbackCapacityLiters : null);

    if (Number.isFinite(Number(volume))) {
      return {
        availableLiters: Math.max(0, Number(volume)),
        capacityLiters: Number.isFinite(Number(capacity)) ? Math.max(1, Number(capacity)) : null,
        levelPercent: Number.isFinite(Number(level)) ? Math.max(0, Math.min(100, Number(level))) : null,
        source: "iot_telemetry",
        capturedAt: row.captured_at ?? row.created_at ?? null,
        deviceUid: row.device_uid ?? null
      };
    }

    if (Number.isFinite(Number(level)) && Number.isFinite(Number(capacity))) {
      const safeLevel = Math.max(0, Math.min(100, Number(level)));
      const safeCapacity = Math.max(1, Number(capacity));
      return {
        availableLiters: safeCapacity * (safeLevel / 100),
        capacityLiters: safeCapacity,
        levelPercent: safeLevel,
        source: "iot_telemetry",
        capturedAt: row.captured_at ?? row.created_at ?? null,
        deviceUid: row.device_uid ?? null
      };
    }
  }

  return null;
}

function buildBatchPlan(input: {
  fullDurationSeconds: number;
  totalLiters: number;
  maxDurationSeconds?: number;
}) {
  const maxDurationSeconds = Math.max(1, Number(input.maxDurationSeconds ?? 1800));
  const fullDurationSeconds = Math.max(0, Number(input.fullDurationSeconds ?? 0));
  const totalLiters = Math.max(0, Number(input.totalLiters ?? 0));

  if (fullDurationSeconds <= 0 || totalLiters <= 0) return [];

  const batchesCount = Math.max(1, Math.ceil(fullDurationSeconds / maxDurationSeconds));
  const batches = [];
  let remainingDuration = fullDurationSeconds;
  let remainingLiters = totalLiters;

  for (let index = 0; index < batchesCount; index += 1) {
    const durationSeconds = Math.min(maxDurationSeconds, remainingDuration);
    const isLast = index === batchesCount - 1;
    const liters = isLast
      ? remainingLiters
      : totalLiters * (durationSeconds / fullDurationSeconds);

    batches.push({
      batch: index + 1,
      start_after_minutes: index * 20,
      duration_seconds: Math.ceil(durationSeconds),
      liters_target: Number(liters.toFixed(2)),
      requires_review_between_batches: index > 0
    });

    remainingDuration -= durationSeconds;
    remainingLiters -= liters;
  }

  return batches;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const selectedLandId = Number(body.landId);
  const flowRateLitersPerMinute = Number(body.flowRateLitersPerMinute ?? 10);
  let tankCapacityLiters = Number(body.tankCapacityLiters);
  let tankAvailableLiters = Number(body.tankAvailableLiters);
  const tankCurrentLiters = Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : null;
  const tankDailyRefillLiters = Math.max(0, Number(body.tankDailyRefillLiters ?? 0));
  const tankReserveLiters = Number(body.tankReserveLiters ?? 0);
  const waterSavingPercent = Number(body.waterSavingPercent ?? 70);
  const irrigationMode = String(body.irrigationMode ?? "medium_productivity");
  const maxLands = Math.max(1, Math.min(12, Number(body.maxLands ?? 12)));
  const executeSafeAuto = Boolean(body.executeSafeAuto);
  const useTelemetryTank = body.useTelemetryTank !== false;
  const moistureThresholdPercent = Math.max(5, Math.min(80, Number(body.moistureThresholdPercent ?? 35)));

  try {
    const supabase = createSupabaseAdmin();
    let landsQuery = supabase
      .from("lands")
      .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,centroid,created_at")
      .order("created_at", { ascending: false })
      .limit(maxLands);

    if (Number.isFinite(selectedLandId) && selectedLandId > 0) {
      landsQuery = supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,centroid,created_at")
        .eq("id", selectedLandId)
        .limit(1);
    }

    const { data: lands, error: landsError } = await landsQuery;
    if (landsError) throw landsError;

    const landIds = (lands ?? []).map((land) => land.id);
    if (!landIds.length) {
      return NextResponse.json({
        summary: "لا توجد أراض محفوظة حتى يعمل Autopilot.",
        score: 0,
        decisions: [],
        portfolio: {
          lands: 0,
          readyToPrepare: 0,
          blocked: 0,
          needsHumanReview: 0
        }
      });
    }

    const [
      analysesResult,
      plantsResult,
      devicesResult,
      telemetryResult,
      recommendationsResult,
      commandsResult
    ] = await Promise.all([
      supabase.from("ai_analyses").select("id,land_id,plant_summary,pest_summary,confidence,created_at").in("land_id", landIds).order("created_at", { ascending: false }).limit(120),
      supabase.from("land_plants").select("id,land_id,name,count,source,updated_at").in("land_id", landIds),
      supabase.from("iot_devices").select("id,land_id,device_uid,is_active,last_seen_at,mqtt_topic_command").in("land_id", landIds),
      supabase.from("iot_telemetry").select("id,land_id,device_uid,soil_moisture_percent,valve_state,raw_payload,captured_at,created_at").in("land_id", landIds).order("created_at", { ascending: false }).limit(80),
      supabase.from("irrigation_recommendations").select("id,land_id,total_liters_per_day,recommended_duration_seconds,status,created_at").in("land_id", landIds).order("created_at", { ascending: false }).limit(80),
      supabase.from("iot_commands").select("id,land_id,status,acknowledged_at,created_at").in("land_id", landIds).order("created_at", { ascending: false }).limit(80)
    ]);

    const analyses = analysesResult.error ? [] : (analysesResult.data ?? []);
    const plants = plantsResult.error ? [] : (plantsResult.data ?? []);
    const devices = devicesResult.error ? [] : (devicesResult.data ?? []);
    const telemetry = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    const recommendations = recommendationsResult.error ? [] : (recommendationsResult.data ?? []);
    const commands = commandsResult.error ? [] : (commandsResult.data ?? []);
    const tankTelemetry = useTelemetryTank ? latestTankReading(telemetry, tankCapacityLiters) : null;
    if (tankTelemetry) {
      tankCapacityLiters = Number(tankTelemetry.capacityLiters ?? tankCapacityLiters);
      tankAvailableLiters = Number(tankTelemetry.availableLiters);
    } else if (tankDailyRefillLiters > 0 && Number.isFinite(tankAvailableLiters) && Number.isFinite(tankCapacityLiters)) {
      tankAvailableLiters = Math.min(Math.max(1, tankCapacityLiters), Math.max(0, tankAvailableLiters) + tankDailyRefillLiters);
    }
    const hasTankReading = Number.isFinite(tankAvailableLiters);

    const decisions = [];

    for (const land of lands ?? []) {
      const landAnalyses = analyses.filter((item) => item.land_id === land.id);
      const landManualPlants = plants.filter((item) => item.land_id === land.id);
      const landPlants = landManualPlants.length ? manualPlants(landManualPlants) : aggregatePlantsByName(landAnalyses);
      const landDevices = devices.filter((item) => item.land_id === land.id);
      const activeDevice = landDevices.find((device) => device.is_active) ?? null;
      const landTelemetry = telemetry.filter((item) => item.land_id === land.id);
      const latestTelemetry = landTelemetry[0] ?? null;
      const latestSoilMoisture = Number(latestTelemetry?.soil_moisture_percent);
      const hasLatestSoilMoisture = Number.isFinite(latestSoilMoisture);
      const moistureAutoTrigger = hasLatestSoilMoisture && latestSoilMoisture < moistureThresholdPercent;
      const landRecommendations = recommendations.filter((item) => item.land_id === land.id);
      const landCommands = commands.filter((item) => item.land_id === land.id);
      const latestAnalysis = landAnalyses[0];
      const latestRisk = latestAnalysis?.pest_summary?.risk_level ?? "unknown";
      const centroid = land.centroid as { coordinates?: [number, number] } | null;
      const lon = centroid?.coordinates?.[0];
      const lat = centroid?.coordinates?.[1];
      const weather = Number.isFinite(lat) && Number.isFinite(lon)
        ? await getWeather(Number(lat), Number(lon)).catch(() => null)
        : null;
      const irrigation = weather && landPlants.length
        ? calculateIrrigation({
          plants: landPlants,
          areaM2: Number(land.area_m2 ?? 0),
          forecastRainMm: Number(weather.forecastRainMm ?? 0),
          flowRateLitersPerMinute,
          tankAvailableLiters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : undefined,
          tankReserveLiters: Number.isFinite(tankReserveLiters) ? tankReserveLiters : undefined,
          waterSavingPercent: Number.isFinite(waterSavingPercent) ? waterSavingPercent : undefined,
          irrigationMode,
          agronomicContext: weather.agronomic,
          sensorContext: latestTelemetry
            ? {
              soilMoisturePercent: latestTelemetry.soil_moisture_percent,
              tankVolumeLiters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : null,
              capturedAt: latestTelemetry.captured_at ?? latestTelemetry.created_at ?? null,
              deviceUid: latestTelemetry.device_uid ?? null
            }
            : null
        })
        : null;
      const fullDuration = Number(irrigation?.recommendedIrrigationDurationSeconds ?? 0);
      const batchPlan = buildBatchPlan({
        fullDurationSeconds: fullDuration,
        totalLiters: Number(irrigation?.executableLiters ?? 0),
        maxDurationSeconds: 1800
      });
      const firstBatch = batchPlan[0] ?? null;
      const safeDuration = Number(firstBatch?.duration_seconds ?? 0);
      const safeLiters = Number(firstBatch?.liters_target ?? 0);
      const tankShortage = Number(irrigation?.tankShortageLiters ?? 0);
      const pestHold = riskRank(latestRisk) >= 3;
      const hasSoilMoisture = hasLatestSoilMoisture || landTelemetry.some((row) => Number.isFinite(Number(row.soil_moisture_percent)));
      const intervalNeedsApproval = Number(irrigation?.irrigationIntervalDays ?? 1) > 1 && !hasSoilMoisture;
      const canPrepare = Boolean(activeDevice && irrigation && safeDuration > 0 && tankShortage <= 0 && !pestHold && hasTankReading && moistureAutoTrigger);

      const blockers = [
        !hasLatestSoilMoisture ? "لا توجد قراءة رطوبة تربة من ESP32" : null,
        hasLatestSoilMoisture && !moistureAutoTrigger ? `رطوبة التربة ${latestSoilMoisture.toFixed(0)}% أعلى من حد التشغيل ${moistureThresholdPercent.toFixed(0)}%` : null,
        !landPlants.length ? "لا يوجد جرد نباتات أو تحليل صور كاف" : null,
        !weather ? "لا توجد قراءة طقس للموقع" : null,
        !activeDevice ? "لا يوجد ESP32 فعال" : null,
        !hasTankReading ? "لا توجد قراءة خزان مؤكدة" : null,
        tankShortage > 0 ? `الخزان ناقص ${tankShortage.toFixed(1)} L` : null,
        pestHold ? "خطر الآفات عالي" : null
      ].filter(Boolean) as string[];
      const warnings = [
        intervalNeedsApproval ? "فاصل الري يحتاج تأكيد آخر سقية أو قراءة رطوبة" : null,
        fullDuration > 1800 ? "الرية الكاملة تحتاج تقسيم إلى دفعات" : null,
        !land.auto_irrigation_enabled ? "الري التلقائي غير مفعل لهذه الأرض" : null,
        !landTelemetry.length ? "لا توجد Telemetry حديثة" : null,
        !landCommands.some((command) => command.acknowledged_at || command.status === "acknowledged") ? "لا يوجد ACK تنفيذ سابق" : null
      ].filter(Boolean) as string[];

      const decision = blockers.length
        ? blockers.some((item) => item.includes("الخزان")) ? "refill_tank" : blockers.some((item) => item.includes("ESP32")) ? "connect_device" : blockers.some((item) => item.includes("آفات")) ? "inspect" : "collect_data"
        : canPrepare
          ? intervalNeedsApproval || !land.auto_irrigation_enabled ? "manual_approval" : "prepare_irrigation"
          : "manual_review";

      let execution: null | {
        status: string;
        commandId?: number;
        commandUuid?: string;
        topic?: string;
        error?: string;
      } = null;

      if (
        executeSafeAuto
        && decision === "prepare_irrigation"
        && land.auto_irrigation_enabled
        && !blockers.length
        && !warnings.filter((warning) => !String(warning).includes("ACK")).length
        && activeDevice
        && safeDuration > 0
        && safeDuration <= 1800
        && batchPlan.length === 1
      ) {
        const commandUuid = randomUUID();
        const topic = activeDevice.mqtt_topic_command || `farms/${land.id}/devices/${activeDevice.device_uid}/commands`;
        const systemRecommendation: any = landRecommendations[0] ?? (irrigation ? {
          id: null,
          total_liters_per_day: irrigation.totalLitersPerDay,
          recommended_duration_seconds: safeDuration,
          status: "computed_from_ai_analysis",
          irrigation_mode: irrigation.irrigationMode,
          irrigation_mode_label: irrigation.irrigationModeLabel
        } : null);
        const safetyReview = await reviewIrrigationCommandSafety({
          land,
          latestAnalysis,
          recommendation: systemRecommendation,
          device: {
            id: activeDevice.id,
            device_uid: activeDevice.device_uid,
            topic
          },
          command: {
            command_id: commandUuid,
            duration_seconds: safeDuration,
            max_duration_seconds: 1800
          }
        });
        const commandPayload: any = {
          command_id: commandUuid,
          land_id: land.id,
          device_uid: activeDevice.device_uid,
          status: "ON",
          duration_seconds: safeDuration,
          issued_at: new Date().toISOString(),
          reason: "Safe Autopilot automatic execution",
          liters_target: safeLiters,
          batch: {
            current: 1,
            total: 1
          },
          recommendation: systemRecommendation
            ? {
                id: systemRecommendation.id,
                liters_per_day: systemRecommendation.total_liters_per_day,
                previous_status: systemRecommendation.status,
                irrigation_mode: systemRecommendation.irrigation_mode,
                irrigation_mode_label: systemRecommendation.irrigation_mode_label
              }
            : null,
          safety: {
            max_duration_seconds: 1800,
            require_ack: true,
            ai_review: safetyReview
          }
        };

        const { data: commandRow, error: commandError } = await supabase
          .from("iot_commands")
          .insert({
            land_id: land.id,
            device_id: activeDevice.id,
            recommendation_id: landRecommendations[0]?.id ?? null,
            command_uuid: commandUuid,
            payload: commandPayload,
            status: "queued"
          })
          .select("id,command_uuid")
          .single();

        if (commandError) {
          execution = { status: "failed_to_queue", error: commandError.message };
        } else if (safetyReview?.decision !== "approve") {
          await supabase
            .from("iot_commands")
            .update({
              status: "failed",
              ack_payload: {
                safety_review: safetyReview,
                blocked_at: new Date().toISOString()
              }
            })
            .eq("id", commandRow.id);
          execution = {
            status: "held_by_ai",
            commandId: commandRow.id,
            commandUuid: commandRow.command_uuid,
            topic,
            error: safetyReview?.operator_message ?? "AI safety review held the command"
          };
        } else {
          try {
            await publishIrrigationCommand(topic, commandPayload);
            await supabase
              .from("iot_commands")
              .update({
                status: "published",
                published_at: new Date().toISOString()
              })
              .eq("id", commandRow.id);
            execution = {
              status: "published",
              commandId: commandRow.id,
              commandUuid: commandRow.command_uuid,
              topic
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : "MQTT publish failed";
            await supabase
              .from("iot_commands")
              .update({
                status: "failed",
                ack_payload: {
                  error: message,
                  failed_at: new Date().toISOString(),
                  safety_review: safetyReview
                }
              })
              .eq("id", commandRow.id);
            execution = {
              status: "failed",
              commandId: commandRow.id,
              commandUuid: commandRow.command_uuid,
              topic,
              error: message
            };
          }
        }
      }

      decisions.push({
        land_id: land.id,
        land_name: land.name,
        decision,
        auto_enabled: Boolean(land.auto_irrigation_enabled),
        auto_execution: execution,
        priority: blockers.length ? "high" : warnings.length ? "medium" : "low",
        confidence: blockers.length ? 0.58 : warnings.length ? 0.74 : 0.86,
        reason: blockers.length
          ? blockers.join(" / ")
          : warnings.length
            ? warnings.join(" / ")
            : "كل شروط التشغيل الأساسية متوفرة",
        water: irrigation ? {
          liters_per_irrigation: irrigation.totalLitersPerIrrigation,
          executable_liters: irrigation.executableLiters,
          safe_batch_liters: safeLiters,
          duration_seconds: safeDuration,
          full_duration_seconds: fullDuration,
          interval_days: irrigation.irrigationIntervalDays,
          irrigation_mode: irrigation.irrigationMode,
          irrigation_mode_label: irrigation.irrigationModeLabel,
          tank_shortage_liters: tankShortage,
          batch_plan: batchPlan
        } : null,
        device: activeDevice ? {
          uid: activeDevice.device_uid,
          topic: activeDevice.mqtt_topic_command || `farms/${land.id}/devices/${activeDevice.device_uid}/commands`
        } : null,
        blockers,
        warnings,
        next_action: blockers[0] ?? warnings[0] ?? "يمكن تجهيز أمر ري آمن للمراجعة",
        evidence: {
          plants: landPlants,
          latest_pest_risk: latestRisk,
          analyses: landAnalyses.length,
          recommendations: landRecommendations.length,
          telemetry: landTelemetry.length,
          soil_moisture: {
            percent: hasLatestSoilMoisture ? latestSoilMoisture : null,
            threshold_percent: moistureThresholdPercent,
            auto_trigger: moistureAutoTrigger,
            captured_at: latestTelemetry?.captured_at ?? latestTelemetry?.created_at ?? null
          },
          commands: landCommands.length,
          tank: {
            capacity_liters: Number.isFinite(tankCapacityLiters) ? tankCapacityLiters : null,
            available_liters: Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : null,
            current_liters: tankTelemetry ? tankAvailableLiters : tankCurrentLiters,
            daily_refill_liters: tankTelemetry ? 0 : tankDailyRefillLiters,
            reserve_liters: Number.isFinite(tankReserveLiters) ? tankReserveLiters : null,
            source: tankTelemetry?.source ?? (Number.isFinite(tankAvailableLiters) ? "manual_input" : "missing"),
            level_percent: tankTelemetry?.levelPercent ?? null,
            captured_at: tankTelemetry?.capturedAt ?? null,
            device_uid: tankTelemetry?.deviceUid ?? null,
            water_saving_percent: irrigation?.waterSavingPercent ?? Math.max(40, Math.min(100, Number.isFinite(waterSavingPercent) ? waterSavingPercent : 70)),
            irrigation_mode: irrigation?.irrigationMode ?? irrigationMode
          }
        }
      });
    }

    decisions.sort((a, b) => {
      const priority = { high: 3, medium: 2, low: 1 };
      return (priority[b.priority as keyof typeof priority] ?? 0) - (priority[a.priority as keyof typeof priority] ?? 0);
    });

    const readyToPrepare = decisions.filter((item) => item.decision === "prepare_irrigation").length;
    const blocked = decisions.filter((item) => item.blockers.length).length;
    const needsHumanReview = decisions.filter((item) => item.decision === "manual_approval" || item.warnings.length).length;
    const score = decisions.length
      ? Math.round(((readyToPrepare * 1 + needsHumanReview * 0.55) / decisions.length) * 100)
      : 0;

    return NextResponse.json({
      summary: blocked
        ? `Autopilot فحص ${decisions.length} أرض وحدد ${blocked} أرض تحتاج معالجة قبل الأتمتة.`
        : `Autopilot فحص ${decisions.length} أرض ولم يجد مانعاً حرجاً.`,
      score,
      portfolio: {
        lands: decisions.length,
        readyToPrepare,
        blocked,
        needsHumanReview,
        autoExecuted: decisions.filter((item: any) => item.auto_execution?.status === "published").length
      },
      decisions
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Autopilot scan failed" },
      { status: 500 }
    );
  }
}
