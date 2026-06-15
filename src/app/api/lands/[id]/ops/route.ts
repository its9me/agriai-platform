import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function pestRiskValue(risk: string | undefined) {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function textKey(value: unknown) {
  return String(value ?? "unknown").trim().toLowerCase();
}

function numberFromPayload(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return null;
  const parsed = Number((payload as Record<string, unknown>)[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function tankFromTelemetry(row: any) {
  const payload = row.raw_payload ?? {};
  if (
    payload &&
    typeof payload === "object" &&
    payload.test_mode === true &&
    payload.tank_sensor_source === undefined
  ) {
    return null;
  }

  const volume = numberFromPayload(payload, "tank_volume_liters");
  const level = numberFromPayload(payload, "tank_level_percent");
  const capacity = numberFromPayload(payload, "tank_capacity_liters");
  const sensorSource = typeof payload.tank_sensor_source === "string" ? payload.tank_sensor_source : null;

  if (Number.isFinite(Number(volume))) {
    return {
      capacity_liters: Number.isFinite(Number(capacity)) ? Number(capacity) : null,
      available_liters: Number(volume),
      level_percent: Number.isFinite(Number(level)) ? Number(level) : null,
      sensor_source: sensorSource
    };
  }

  if (Number.isFinite(Number(level)) && Number.isFinite(Number(capacity))) {
    return {
      capacity_liters: Number(capacity),
      available_liters: Number(capacity) * (Number(level) / 100),
      level_percent: Number(level),
      sensor_source: sensorSource
    };
  }

  return null;
}

const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

function timeMs(value: unknown) {
  const parsed = value ? new Date(String(value)).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueImagery(items: any[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const key = metadata.sha256
      || (metadata.originalName && metadata.size ? `${metadata.originalName}:${metadata.size}` : null)
      || metadata.originalName
      || item.image_url
      || item.id;
    if (seen.has(String(key))) return false;
    seen.add(String(key));
    return true;
  });
}

function manualPlantAggregate(manualPlants: any[], imagery: any[], analyses: any[]) {
  return {
    source: "manual",
    uniqueImages: uniqueImagery(imagery).length,
    totalImageRecords: imagery.length,
    totalAnalyses: analyses.length,
    duplicateImageRecords: Math.max(0, imagery.length - uniqueImagery(imagery).length),
    uniquePlantGroups: manualPlants.length,
    estimatedPlantsTotal: manualPlants.reduce((sum, plant) => sum + Number(plant.count ?? 0), 0),
    plants: manualPlants.map((plant) => ({
      name: plant.name,
      estimatedCount: Number(plant.count ?? 0),
      sightings: 1,
      averageConfidence: 1,
      stages: [plant.growth_stage ?? "unknown"],
      analysisIds: [],
      notes: plant.notes ?? "",
      source: plant.source ?? "manual"
    })),
    pest: {
      highestRisk: analyses.map((analysis) => String(analysis.pest_summary?.risk_level ?? "unknown")).sort((a, b) => pestRiskValue(b) - pestRiskValue(a))[0] ?? "unknown",
      redPalmWeevilDetected: analyses.some((analysis) => Boolean(analysis.pest_summary?.red_palm_weevil_indicators?.detected)),
      redPalmWeevilSightings: analyses.filter((analysis) => Boolean(analysis.pest_summary?.red_palm_weevil_indicators?.detected)).length
    }
  };
}

function aggregatePlantEvidence(analyses: any[], imagery: any[], manualPlants: any[] = []) {
  if (manualPlants.length) {
    return manualPlantAggregate(manualPlants, imagery, analyses);
  }

  const plantMap = new Map<string, {
    name: string;
    count: number;
    maxCount: number;
    sightings: number;
    confidenceTotal: number;
    stages: Set<string>;
    analysisIds: number[];
  }>();

  for (const analysis of analyses) {
    const plants = Array.isArray(analysis.plant_summary?.plants)
      ? analysis.plant_summary.plants
      : [];

    for (const plant of plants) {
      const name = String(plant.name ?? "Unknown plant").trim();
      const stage = String(plant.growth_stage ?? "unknown").trim();
      const key = textKey(name);
      const existing = plantMap.get(key) ?? {
        name,
        count: 0,
        maxCount: 0,
        sightings: 0,
        confidenceTotal: 0,
        stages: new Set<string>(),
        analysisIds: []
      };
      const count = Math.max(0, Number(plant.count ?? 0));
      existing.maxCount = Math.max(existing.maxCount, count);
      existing.count += count;
      existing.sightings += 1;
      existing.confidenceTotal += Math.max(0, Number(plant.count_confidence ?? 0));
      existing.stages.add(stage);
      existing.analysisIds.push(Number(analysis.id));
      plantMap.set(key, existing);
    }
  }

  const plants = Array.from(plantMap.values()).map((plant) => ({
    name: plant.name,
    estimatedCount: plant.maxCount || plant.count,
    sightings: plant.sightings,
    averageConfidence: plant.sightings ? plant.confidenceTotal / plant.sightings : 0,
    stages: Array.from(plant.stages),
    analysisIds: Array.from(new Set(plant.analysisIds))
  }));

  const pestRisks = analyses.map((analysis) => String(analysis.pest_summary?.risk_level ?? "unknown"));
  const redPalmEvidence = analyses.filter((analysis) => Boolean(analysis.pest_summary?.red_palm_weevil_indicators?.detected));

  return {
    uniqueImages: uniqueImagery(imagery).length,
    totalImageRecords: imagery.length,
    totalAnalyses: analyses.length,
    duplicateImageRecords: Math.max(0, imagery.length - uniqueImagery(imagery).length),
    uniquePlantGroups: plants.length,
    estimatedPlantsTotal: plants.reduce((sum, plant) => sum + Number(plant.estimatedCount ?? 0), 0),
    plants,
    pest: {
      highestRisk: pestRisks.sort((a, b) => pestRiskValue(b) - pestRiskValue(a))[0] ?? "unknown",
      redPalmWeevilDetected: redPalmEvidence.length > 0,
      redPalmWeevilSightings: redPalmEvidence.length
    }
  };
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const landId = Number(id);

  if (!Number.isFinite(landId)) {
    return NextResponse.json({ error: "invalid land id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const [
      landResult,
      analysesResult,
      recommendationsResult,
      commandsResult,
      devicesResult,
      telemetryResult,
      imageryResult,
      notesResult,
      plansResult,
      decisionsResult,
      plantsResult
    ] = await Promise.all([
      supabase
        .from("lands")
        .select("id,name,crop_hint,area_m2,auto_irrigation_enabled,created_at")
        .eq("id", landId)
        .single(),
      supabase
        .from("ai_analyses")
        .select("id,plant_summary,pest_summary,confidence,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("irrigation_recommendations")
        .select("id,total_liters_per_day,rain_deduction_liters,recommended_duration_seconds,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("iot_commands")
        .select("id,status,payload,published_at,acknowledged_at,ack_payload,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("iot_devices")
        .select("id,device_uid,is_active,last_seen_at")
        .eq("land_id", landId),
      supabase
        .from("iot_telemetry")
        .select("id,device_uid,soil_moisture_percent,temperature_c,humidity_percent,flow_liters_per_minute,valve_state,battery_percent,raw_payload,captured_at,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(12),
      supabase
        .from("imagery")
        .select("id,image_url,source,captured_at,created_at,metadata")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(6),
      supabase
        .from("field_notes")
        .select("id,note,triage_json,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("ai_action_plans")
        .select("id,plan_json,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("ai_decisions")
        .select("id,decision_json,evidence_counts,status,created_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("land_plants")
        .select("id,name,count,growth_stage,notes,source,created_at,updated_at")
        .eq("land_id", landId)
        .order("created_at", { ascending: false })
    ]);

    for (const result of [landResult, analysesResult, recommendationsResult, commandsResult, devicesResult]) {
      if (result.error) throw result.error;
    }

    const analyses = analysesResult.data ?? [];
    const recommendations = recommendationsResult.data ?? [];
    const commands = commandsResult.data ?? [];
    const devices = devicesResult.data ?? [];
    const telemetry = telemetryResult.error
      ? []
      : (telemetryResult.data ?? []).map((row) => ({
        ...row,
        is_test_mode: row.raw_payload?.test_mode === true,
        has_soil_moisture_sensor: row.raw_payload?.soil_moisture_percent !== undefined,
        has_tank_sensor: row.raw_payload?.tank_sensor_source !== undefined,
        tank: tankFromTelemetry(row)
      }));
    const latestTelemetryByDevice = new Map<string, any>();
    for (const reading of telemetry) {
      if (!latestTelemetryByDevice.has(reading.device_uid)) {
        latestTelemetryByDevice.set(reading.device_uid, reading);
      }
    }
    const nowMs = Date.now();
    const devicesWithConnection = devices.map((device) => {
      const latestTelemetry = latestTelemetryByDevice.get(device.device_uid);
      const lastSeenMs = Math.max(
        timeMs(device.last_seen_at) ?? 0,
        timeMs(latestTelemetry?.captured_at) ?? 0,
        timeMs(latestTelemetry?.created_at) ?? 0
      );
      const secondsSinceSeen = lastSeenMs > 0 ? Math.floor((nowMs - lastSeenMs) / 1000) : null;
      const connected = Boolean(
        device.is_active &&
        secondsSinceSeen !== null &&
        secondsSinceSeen <= DEVICE_ONLINE_WINDOW_MS / 1000
      );

      return {
        ...device,
        registered_is_active: device.is_active,
        is_active: connected,
        connection_status: connected ? "online" : "offline",
        seconds_since_seen: secondsSinceSeen,
        latest_seen_at: lastSeenMs > 0 ? new Date(lastSeenMs).toISOString() : null
      };
    });
    const connectedDevices = devicesWithConnection.filter((device) => device.connection_status === "online").length;
    const imagery = imageryResult.error ? [] : (imageryResult.data ?? []);
    const notes = notesResult.error ? [] : (notesResult.data ?? []);
    const plans = plansResult.error ? [] : (plansResult.data ?? []);
    const decisions = decisionsResult.error ? [] : (decisionsResult.data ?? []);
    const manualPlants = plantsResult.error ? [] : (plantsResult.data ?? []);
    const uniqueImageryRows = uniqueImagery(imagery);
    const imageryWithSignedUrls = await Promise.all(
      uniqueImageryRows.map(async (item) => {
        const path = item.image_url;
        if (!path) return { ...item, signed_url: null };

        const { data, error } = await supabase.storage
          .from("imagery")
          .createSignedUrl(path, 60 * 30);

        return {
          ...item,
          signed_url: error ? null : data.signedUrl
        };
      })
    );
    const latestAnalysis = analyses[0];
    const latestRecommendation = recommendations[0];
    const latestRisk = (latestAnalysis?.pest_summary as any)?.risk_level as string | undefined;
    const maxRisk = analyses.reduce((max, analysis) => {
      return Math.max(max, pestRiskValue((analysis.pest_summary as any)?.risk_level));
    }, 0);

    const operationalDecision = latestRecommendation
      ? latestRecommendation.status === "sent_to_iot"
        ? "تم إرسال توصية الري إلى جهاز التحكم."
        : "توجد توصية ري جاهزة للمراجعة أو الإرسال."
      : "لا توجد توصية ري محفوظة بعد. شغّل تحليل صورة أو مستشار AI.";

    return NextResponse.json({
      land: landResult.data,
      summary: {
        analysesCount: analyses.length,
        recommendationsCount: recommendations.length,
        commandsCount: commands.length,
        devicesCount: devices.length,
        telemetryCount: telemetry.length,
        imageryCount: imageryWithSignedUrls.length,
        duplicateImageryCount: Math.max(0, imagery.length - imageryWithSignedUrls.length),
        fieldNotesCount: notes.length,
        actionPlansCount: plans.length,
        aiDecisionsCount: decisions.length,
        activeDevices: connectedDevices,
        connectedDevices,
        offlineDevices: Math.max(0, devices.length - connectedDevices),
        deviceConnectionStatus: devices.length ? connectedDevices > 0 ? "online" : "offline" : "not_registered",
        latestDeviceSeenAt: devicesWithConnection
          .map((device) => device.latest_seen_at)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
        latestPestRisk: latestRisk ?? "unknown",
        maxRisk,
        latestRecommendedLiters: latestRecommendation?.total_liters_per_day ?? 0,
        latestDurationSeconds: latestRecommendation?.recommended_duration_seconds ?? 0,
        operationalDecision
      },
      aggregate: aggregatePlantEvidence(analyses, imagery, manualPlants),
      recent: {
        analyses,
        recommendations,
        commands,
        devices: devicesWithConnection,
        telemetry,
        imagery: imageryWithSignedUrls,
        notes,
        plans,
        decisions,
        manualPlants
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Land operations failed" },
      { status: 500 }
    );
  }
}
