import { NextRequest, NextResponse } from "next/server";
import { calculateIrrigation } from "@/lib/irrigation";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getWeather } from "@/lib/weather";

function aggregatePlants(analyses: any[]) {
  const groups = new Map<string, { name: string; count: number; source: string }>();

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
        count: Math.max(current?.count ?? 0, count),
        source: "image_ai"
      });
    }
  }

  return Array.from(groups.values());
}

function priorityWeight(input: {
  missing: string[];
  tankShortageLiters: number;
  pestRisk: string;
  dailyAverageLiters: number;
}) {
  let score = input.dailyAverageLiters;
  if (input.tankShortageLiters > 0) score += input.tankShortageLiters * 0.6;
  if (input.pestRisk === "high") score += 400;
  if (input.pestRisk === "medium") score += 180;
  score += input.missing.length * 75;
  return score;
}

function numberFromPayload(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  const parsed = Number(value);
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

    const directVolume = Number(row.tank_volume_liters);
    const payloadVolume = numberFromPayload(payload, "tank_volume_liters");
    const volume = Number.isFinite(directVolume) ? directVolume : payloadVolume;
    const directCapacity = Number(row.tank_capacity_liters);
    const payloadCapacity = numberFromPayload(payload, "tank_capacity_liters");
    const capacity = Number.isFinite(directCapacity)
      ? directCapacity
      : payloadCapacity ?? fallbackCapacityLiters;
    const directLevel = Number(row.tank_level_percent);
    const payloadLevel = numberFromPayload(payload, "tank_level_percent");
    const level = Number.isFinite(directLevel) ? directLevel : payloadLevel;

    if (Number.isFinite(Number(volume))) {
      return {
        availableLiters: Math.max(0, Number(volume)),
        capacityLiters: Math.max(1, Number(capacity) || fallbackCapacityLiters),
        levelPercent: Number.isFinite(Number(level)) ? Math.max(0, Math.min(100, Number(level))) : null,
        source: "iot_telemetry",
        capturedAt: row.captured_at ?? row.created_at ?? null,
        deviceUid: row.device_uid ?? null
      };
    }

    if (Number.isFinite(Number(level)) && Number.isFinite(Number(capacity))) {
      const safeCapacity = Math.max(1, Number(capacity));
      return {
        availableLiters: safeCapacity * (Math.max(0, Math.min(100, Number(level))) / 100),
        capacityLiters: safeCapacity,
        levelPercent: Math.max(0, Math.min(100, Number(level))),
        source: "iot_telemetry",
        capturedAt: row.captured_at ?? row.created_at ?? null,
        deviceUid: row.device_uid ?? null
      };
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  let tankCapacityLiters = Number(body.tankCapacityLiters ?? 2000);
  let tankAvailableLiters = Number(body.tankAvailableLiters ?? 2000);
  const tankCurrentLiters = Number.isFinite(tankAvailableLiters) ? tankAvailableLiters : 0;
  const tankDailyRefillLiters = Math.max(0, Number(body.tankDailyRefillLiters ?? 0));
  const tankReserveLiters = Number(body.tankReserveLiters ?? 80);
  const flowRateLitersPerMinute = Number(body.flowRateLitersPerMinute ?? 10);
  const waterSavingPercent = Number(body.waterSavingPercent ?? 70);
  const irrigationMode = String(body.irrigationMode ?? "medium_productivity");
  const useTelemetryTank = body.useTelemetryTank !== false;

  try {
    const supabase = createSupabaseAdmin();
    const [
      landsResult,
      plantsResult,
      analysesResult,
      devicesResult,
      telemetryResult
    ] = await Promise.all([
      supabase.from("lands").select("id,name,crop_hint,area_m2,centroid,auto_irrigation_enabled,created_at").order("created_at", { ascending: false }),
      supabase.from("land_plants").select("id,land_id,name,count,source,updated_at"),
      supabase.from("ai_analyses").select("id,land_id,plant_summary,pest_summary,confidence,created_at").order("created_at", { ascending: false }).limit(120),
      supabase.from("iot_devices").select("id,land_id,device_uid,is_active,last_seen_at"),
      supabase.from("iot_telemetry").select("id,land_id,device_uid,soil_moisture_percent,valve_state,raw_payload,captured_at,created_at").order("created_at", { ascending: false }).limit(80)
    ]);

    if (landsResult.error) throw landsResult.error;

    const lands = landsResult.data ?? [];
    const plants = plantsResult.error ? [] : (plantsResult.data ?? []);
    const analyses = analysesResult.error ? [] : (analysesResult.data ?? []);
    const devices = devicesResult.error ? [] : (devicesResult.data ?? []);
    const telemetry = telemetryResult.error ? [] : (telemetryResult.data ?? []);
    const tankTelemetry = useTelemetryTank ? latestTankReading(telemetry, tankCapacityLiters) : null;
    if (tankTelemetry) {
      tankCapacityLiters = tankTelemetry.capacityLiters;
      tankAvailableLiters = tankTelemetry.availableLiters;
    } else if (tankDailyRefillLiters > 0 && Number.isFinite(tankCapacityLiters)) {
      tankAvailableLiters = Math.min(Math.max(1, tankCapacityLiters), Math.max(0, tankAvailableLiters) + tankDailyRefillLiters);
    }
    const usableTankLiters = Math.max(0, tankAvailableLiters - tankReserveLiters);
    const allocations = [];

    for (const land of lands) {
      const manualPlants = plants.filter((item) => item.land_id === land.id);
      const landAnalyses = analyses.filter((item) => item.land_id === land.id);
      const landPlants = manualPlants.length
        ? manualPlants.map((plant) => ({
          name: String(plant.name ?? "unknown"),
          count: Math.max(0, Number(plant.count ?? 0)),
          source: plant.source ?? "manual"
        }))
        : aggregatePlants(landAnalyses);
      const centroid = land.centroid as { coordinates?: [number, number] } | null;
      const lon = centroid?.coordinates?.[0];
      const lat = centroid?.coordinates?.[1];
      const weather = Number.isFinite(lat) && Number.isFinite(lon)
        ? await getWeather(Number(lat), Number(lon)).catch(() => null)
        : null;
      const activeDevice = devices.find((device) => device.land_id === land.id && device.is_active) ?? null;
      const landTelemetry = telemetry.filter((item) => item.land_id === land.id);
      const latestTelemetry = landTelemetry[0] ?? null;
      const irrigation = landPlants.length
        ? calculateIrrigation({
          plants: landPlants,
          areaM2: Number(land.area_m2 ?? 0),
          forecastRainMm: Number(weather?.forecastRainMm ?? 0),
          flowRateLitersPerMinute,
          tankAvailableLiters,
          tankReserveLiters,
          waterSavingPercent,
          irrigationMode,
          agronomicContext: weather?.agronomic ?? null,
          sensorContext: latestTelemetry
            ? {
              soilMoisturePercent: latestTelemetry.soil_moisture_percent,
              tankVolumeLiters: tankAvailableLiters,
              capturedAt: latestTelemetry.captured_at ?? latestTelemetry.created_at ?? null,
              deviceUid: latestTelemetry.device_uid ?? null
            }
            : null
        })
        : null;
      const pestRisk = String(landAnalyses[0]?.pest_summary?.risk_level ?? "unknown");
      const missing = [
        !landPlants.length ? "plant_inventory" : null,
        !weather ? "weather" : null,
        !activeDevice ? "active_esp32" : null,
        !landTelemetry.length ? "telemetry" : null
      ].filter(Boolean) as string[];
      const requiredLiters = Number(irrigation?.totalLitersPerIrrigation ?? 0);
      const executableLiters = Number(irrigation?.executableLiters ?? 0);
      const shortageLiters = Number(irrigation?.tankShortageLiters ?? 0);

      allocations.push({
        land_id: land.id,
        land_name: land.name,
        auto_enabled: Boolean(land.auto_irrigation_enabled),
        required_liters: requiredLiters,
        executable_liters: executableLiters,
        shortage_liters: shortageLiters,
        daily_average_liters: Number(irrigation?.dailyAverageLiters ?? 0),
        interval_days: Number(irrigation?.irrigationIntervalDays ?? 1),
        irrigation_mode: irrigation?.irrigationMode ?? irrigationMode,
        irrigation_mode_label: irrigation?.irrigationModeLabel ?? irrigationMode,
        water_saving_percent: irrigation?.waterSavingPercent ?? Math.max(40, Math.min(100, Number.isFinite(waterSavingPercent) ? waterSavingPercent : 70)),
        agronomic_adjustment: irrigation?.agronomicAdjustment ?? null,
        duration_seconds: Number(irrigation?.recommendedIrrigationDurationSeconds ?? 0),
        plants: landPlants,
        pest_risk: pestRisk,
        device_uid: activeDevice?.device_uid ?? null,
        soil_moisture_percent: latestTelemetry?.soil_moisture_percent ?? null,
        soil_moisture_adjustment_factor: irrigation?.soilMoistureAdjustmentFactor ?? 1,
        soil_moisture_deduction_liters: irrigation?.soilMoistureDeductionLiters ?? 0,
        missing,
        decision: !landPlants.length
          ? "collect_inventory"
          : shortageLiters > 0
            ? "refill_tank"
            : !activeDevice
              ? "connect_device"
              : "ready_for_admin_approval",
        priority_score: priorityWeight({
          missing,
          tankShortageLiters: shortageLiters,
          pestRisk,
          dailyAverageLiters: Number(irrigation?.dailyAverageLiters ?? 0)
        })
      });
    }

    allocations.sort((a, b) => b.priority_score - a.priority_score);

    const totalRequiredLiters = allocations.reduce((sum, item) => sum + item.required_liters, 0);
    const totalExecutableLiters = Math.min(usableTankLiters, totalRequiredLiters);
    const totalShortageLiters = Math.max(0, totalRequiredLiters - usableTankLiters);
    const appliedWaterPercent = allocations.length
      ? allocations.reduce((sum, item) => sum + Number(item.water_saving_percent ?? 0), 0) / allocations.length
      : Math.max(40, Math.min(100, Number.isFinite(waterSavingPercent) ? waterSavingPercent : 70));
    let remainingTankLiters = usableTankLiters;
    const maxSafeDurationSeconds = 1800;
    const maxSafeLiters = Math.max(0, flowRateLitersPerMinute * (maxSafeDurationSeconds / 60));
    const dispatchOrder = allocations.map((item, index) => {
      const allocatedLiters = Math.min(remainingTankLiters, item.required_liters);
      remainingTankLiters = Math.max(0, remainingTankLiters - allocatedLiters);
      const safeBatchLiters = Math.min(allocatedLiters, maxSafeLiters);
      const safeBatchDurationSeconds = flowRateLitersPerMinute > 0
        ? Math.ceil((safeBatchLiters / flowRateLitersPerMinute) * 60)
        : 0;
      return {
        rank: index + 1,
        land_id: item.land_id,
        land_name: item.land_name,
        device_uid: item.device_uid,
        allocated_liters: Number(allocatedLiters.toFixed(2)),
        unmet_liters: Number(Math.max(0, item.required_liters - allocatedLiters).toFixed(2)),
        safe_batch_liters: Number(safeBatchLiters.toFixed(2)),
        safe_batch_duration_seconds: safeBatchDurationSeconds,
        decision: allocatedLiters <= 0 ? "no_water_available" : item.decision,
        reason: item.missing.length
          ? item.missing.join(" / ")
          : item.shortage_liters > 0
            ? `tank_shortage_${item.shortage_liters.toFixed(1)}L`
            : "ready"
      };
    });

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      tank: {
        capacity_liters: tankCapacityLiters,
        available_liters: tankAvailableLiters,
        current_liters: tankTelemetry ? tankAvailableLiters : tankCurrentLiters,
        daily_refill_liters: tankTelemetry ? 0 : tankDailyRefillLiters,
        reserve_liters: tankReserveLiters,
        usable_liters: usableTankLiters,
        remaining_after_plan_liters: Number(remainingTankLiters.toFixed(2)),
        source: tankTelemetry?.source ?? "manual_input",
        level_percent: tankTelemetry?.levelPercent ?? null,
        captured_at: tankTelemetry?.capturedAt ?? null,
        device_uid: tankTelemetry?.deviceUid ?? null
      },
      water_policy: {
        water_saving_percent: Number(appliedWaterPercent.toFixed(0)),
        irrigation_mode: irrigationMode,
        irrigation_mode_label: allocations[0]?.irrigation_mode_label ?? irrigationMode,
        source: "operator_setting"
      },
      summary: {
        lands: allocations.length,
        total_required_liters: Number(totalRequiredLiters.toFixed(2)),
        total_executable_liters: Number(totalExecutableLiters.toFixed(2)),
        total_shortage_liters: Number(totalShortageLiters.toFixed(2)),
        ready_lands: allocations.filter((item) => item.decision === "ready_for_admin_approval").length,
        refill_needed_lands: allocations.filter((item) => item.decision === "refill_tank").length
      },
      allocations,
      dispatch_order: dispatchOrder
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Water budget failed" },
      { status: 500 }
    );
  }
}
