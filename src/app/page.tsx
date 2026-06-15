"use client";

import dynamic from "next/dynamic";
import type { User } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

const SatelliteLandMap = dynamic(
  () => import("@/components/SatelliteLandMap").then((mod) => mod.SatelliteLandMap),
  { ssr: false }
);

const IRRIGATION_MODE_OPTIONS: Array<{
  id: IrrigationModeOption;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    id: "survival",
    label: "البقاء على قيد الحياة",
    shortLabel: "Survival",
    description: "أقل كمية محسوبة لتقليل خطر الذبول والموت. لا تعتبر هدف إنتاج."
  },
  {
    id: "medium_productivity",
    label: "إنتاجية متوسطة",
    shortLabel: "Medium",
    description: "ري ناقص منظم قريب من 50-70% من الاحتياج الكامل لتوفير الماء مع إنتاج مقبول."
  },
  {
    id: "full_irrigation",
    label: "ري كامل",
    shortLabel: "Full",
    description: "تغطية الاحتياج المائي الكامل ETc بعد خصم المطر الفعال وحدود الخزان."
  }
];

type Health = {
  configured: Record<string, boolean>;
};

type IrrigationModeOption = "survival" | "medium_productivity" | "full_irrigation";
type OpsView = "overview" | "recommendations" | "auto" | "manual" | "hardware" | "live" | "ai";
type ActiveSection = "assets" | "map" | "field" | "ops" | "demo" | "admin" | "settings";

const OPS_VIEW_META: Record<OpsView, { title: string; description: string }> = {
  overview: {
    title: "نظرة تشغيلية",
    description: "ملخص سريع لحالة الأرض، آخر قرار، المراقبة الحية، ومؤشرات الجاهزية بدون ازدحام أدوات."
  },
  recommendations: {
    title: "توصيات الري",
    description: "حساب كمية الماء، مود الري، الخزان، الجدولة، وتوصية النظام قبل أي تشغيل."
  },
  auto: {
    title: "الري التلقائي",
    description: "تشغيل Autopilot عندما تكون توصية AI صالحة، الخزان كافي، و ESP32 متصل."
  },
  manual: {
    title: "الري اليدوي",
    description: "تحكم مباشر بصلاحية المدير لإرسال أمر ري محدد بالثواني واللترات مع مراقبة الحالة."
  },
  hardware: {
    title: "ESP32",
    description: "تجهيز وفحص قطعة ESP32، اختبار Relay، ومراجعة الاتصال والجاهزية."
  },
  live: {
    title: "المراقبة الحية",
    description: "متابعة الأمر الحالي: هل استلمته ESP32، هل الصمام مفتوح، كم ماء صرف، وهل اكتمل الإغلاق."
  },
  ai: {
    title: "أدوات AI",
    description: "كل أدوات التحليل المتقدم، سؤال الأرض، التقارير، خطط العمل، وتنبيهات الآفات والطقس."
  }
};

type SetupDoctor = {
  score: number;
  missing: Array<{
    type: string;
    name: string;
    fix: string | null;
  }>;
};

type AnalyzeResult = {
  analysis: {
    plants?: Array<{
      name: string;
      count: number;
      count_confidence: number;
      growth_stage?: string;
      notes: string;
    }>;
    pests?: {
      detected: boolean;
      risk_level: string;
      suspected_pests?: Array<{
        name: string;
        evidence: string[];
        confidence: number;
      }>;
      red_palm_weevil_indicators?: {
        detected: boolean;
        evidence: string[];
        confidence: number;
      };
    };
    image_quality?: {
      score: number;
      limitations: string[];
    };
    overall_confidence?: number;
    requires_human_review?: boolean;
  };
  weather: {
    currentRainMm: number;
    forecastRainMm: number;
  };
  irrigation: {
    baseLiters: number;
    rawBaseLiters?: number;
    rawTotalLitersPerIrrigation?: number;
    irrigationMode?: string;
    irrigationModeLabel?: string;
    irrigationModeReason?: string;
    irrigationModeSource?: string;
    waterSavingPercent?: number;
    waterSavingFactor?: number;
    dailyAverageLiters?: number;
    rainDeductionLiters: number;
    soilMoisturePercent?: number | null;
    soilMoistureAdjustmentFactor?: number;
    soilMoistureDeductionLiters?: number;
    sensorContext?: unknown;
    totalLitersPerDay: number;
    totalLitersPerIrrigation?: number;
    executableLiters?: number;
    tankAvailableLiters?: number | null;
    tankReserveLiters?: number;
    usableTankLiters?: number | null;
    tankShortageLiters?: number;
    canCompleteIrrigation?: boolean;
    irrigationIntervalDays?: number;
    recommendedDurationSeconds: number;
    recommendedIrrigationDurationSeconds?: number;
  };
  sensorContext?: unknown;
  saved?: null | {
    imageryId: number | null;
    imagePath: string | null;
    aiAnalysisId: number;
    recommendationId: number;
    duplicateImage?: boolean;
  };
};

type PottedPlantAnalysisResult = {
  analysis: {
    plant?: {
      name?: string;
      arabic_name?: string;
      growth_stage?: string;
      estimated_height_cm?: { min?: number; max?: number; confidence?: number };
      canopy_width_cm?: { min?: number; max?: number; confidence?: number };
      health_status?: string;
      visible_stress_signs?: string[];
    };
    container?: {
      type?: string;
      estimated_top_diameter_cm?: { min?: number; max?: number; confidence?: number };
      estimated_depth_cm?: { min?: number; max?: number; confidence?: number };
      estimated_volume_liters?: { min?: number; max?: number; confidence?: number };
      drainage_visible?: string;
    };
    soil?: {
      visible_surface_area_percent?: number;
      surface_condition?: string;
      estimated_soil_volume_liters?: { min?: number; max?: number; confidence?: number };
      limitations?: string[];
    };
    irrigation?: {
      watering_percent_of_soil_volume?: number;
      recommended_liters_now?: { min?: number; max?: number; best?: number };
      recommended_interval_days?: { min?: number; max?: number };
      reason?: string;
      safety_notes?: string[];
    };
    image_quality?: { score?: number; limitations?: string[] };
    overall_confidence?: number;
    requires_human_review?: boolean;
  };
  commandPreview: {
    liters_target: number;
    raw_liters_target?: number;
    duration_seconds: number;
    flow_rate_liters_per_minute: number;
    watering_percent_of_soil_volume: number;
    soil_moisture_percent?: number | null;
    soil_moisture_adjustment_factor?: number;
  };
  sensorContext?: unknown;
  saved?: null | {
    pottedPlantId: number;
    imagePath: string;
    reusedImage?: boolean;
  };
};

type PottedPlant = {
  id: number;
  owner_id?: string | null;
  linked_land_id?: number | null;
  name: string;
  location_label?: string | null;
  image_url: string;
  signed_image_url?: string | null;
  image_metadata?: Record<string, unknown>;
  target_boundary_geojson?: Record<string, unknown>;
  target_area_m2?: number | null;
  analysis_json?: PottedPlantAnalysisResult["analysis"];
  command_preview?: PottedPlantAnalysisResult["commandPreview"];
  sensor_context?: unknown;
  flow_rate_liters_per_minute?: number;
  notes?: string | null;
  status?: string;
  created_at: string;
  updated_at?: string;
  lands?: { id: number; name: string; crop_hint?: string | null } | null;
};

type IotDeviceInventoryResult = {
  devices: Array<{
    id: number;
    land_id: number;
    device_uid: string;
    mqtt_topic_command: string;
    mqtt_topic_ack: string;
    relay_pin: number;
    is_active: boolean;
    last_seen_at: string | null;
    connection_status: "online" | "offline";
    hardware_profile?: Record<string, unknown> | null;
    pump_flow_liters_per_minute?: number | null;
    soil_sensor_model?: string | null;
    tank_sensor_model?: string | null;
    relay_model?: string | null;
    pump_model?: string | null;
    notes?: string | null;
    land?: { id: number; name: string; crop_hint: string | null } | null;
    latestTelemetry?: {
      soil_moisture_percent: number | null;
      flow_liters_per_minute: number | null;
      tank_level_percent: number | null;
      tank_volume_liters: number | null;
      valve_state: string;
      captured_at: string;
    } | null;
  }>;
};

type Land = {
  id: number;
  owner_id?: string | null;
  name: string;
  crop_hint: string | null;
  boundary_geojson?: {
    type?: string;
    coordinates?: number[][][];
  } | null;
  area_m2: number;
  auto_irrigation_enabled?: boolean;
  latest_image?: {
    image_url: string;
    signed_url: string | null;
    source: string | null;
  } | null;
  created_at: string;
  updated_at?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  delete_reason?: string | null;
};

type AppProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: "farmer" | "admin" | "operator";
  is_active: boolean;
};

type AdminUser = AppProfile & {
  land_memberships?: Array<{
    id: number;
    land_id: number;
    role: string;
    lands?: { id: number; name: string } | null;
  }>;
};

type Toast = {
  id: number;
  type: "info" | "success" | "error";
  message: string;
};

type CropCatalogItem = {
  id: string;
  nameEn: string;
  nameAr: string;
  unit: "plant" | "tree" | "m2";
  litersPerUnitPerIrrigation: number;
  intervalDays: number;
  wateringPercent: number;
  season: string;
  method?: string;
  source?: string;
  dailyLitersPerUnit: number;
  modeFactors?: Partial<Record<IrrigationModeOption, number>>;
};

type PlaceInfo = {
  displayName: string;
  city: string;
  district: string;
  governorate: string;
  country: string;
};

type AdvisoryResult = {
  advisory: {
    executive_summary: string;
    field_readiness_score: number;
    priority_actions: Array<{
      title: string;
      reason: string;
      impact: string;
      urgency: string;
    }>;
    irrigation_strategy: {
      recommended_mode: string;
      why: string;
      rain_adjustment_note: string;
    };
    pest_watch: {
      risk_level: string;
      what_to_inspect: string[];
      image_capture_guidance: string[];
    };
    project_manager_view: {
      judge_pitch: string;
      value_metrics: string[];
      next_integrations: string[];
    };
    missing_data: string[];
  };
};

type Dashboard = {
  totals: {
    lands: number;
    areaM2: number;
    analyses: number;
    recommendations: number;
    activeDevices: number;
    autoIrrigationLands: number;
    highRiskAnalyses: number;
    latestRecommendedLiters: number;
  };
};

type LandOps = {
  land: Land;
  summary: {
    analysesCount: number;
    recommendationsCount: number;
    commandsCount: number;
    devicesCount: number;
    telemetryCount: number;
    imageryCount: number;
    duplicateImageryCount?: number;
    fieldNotesCount: number;
    actionPlansCount: number;
    aiDecisionsCount: number;
    activeDevices: number;
    connectedDevices?: number;
    offlineDevices?: number;
    deviceConnectionStatus?: "online" | "offline" | "not_registered";
    latestDeviceSeenAt?: string | null;
    latestPestRisk: string;
    maxRisk: number;
    latestRecommendedLiters: number;
    latestDurationSeconds: number;
    operationalDecision: string;
  };
  aggregate?: {
    source?: string;
    uniqueImages: number;
    totalImageRecords: number;
    duplicateImageRecords: number;
    totalAnalyses: number;
    uniquePlantGroups: number;
    estimatedPlantsTotal: number;
    plants: Array<{
      name: string;
      estimatedCount: number;
      sightings: number;
      averageConfidence: number;
      stages: string[];
      analysisIds: number[];
      notes?: string;
      source?: string;
    }>;
    pest: {
      highestRisk: string;
      redPalmWeevilDetected: boolean;
      redPalmWeevilSightings: number;
    };
  };
  recent: {
    analyses: Array<{
      id: number;
      plant_summary: unknown;
      pest_summary: unknown;
      confidence: number;
      created_at: string;
    }>;
    recommendations: Array<{
      id: number;
      total_liters_per_day: number;
      rain_deduction_liters: number;
      recommended_duration_seconds: number;
      flow_rate_liters_per_minute?: number | null;
      status: string;
      created_at: string;
    }>;
    commands: Array<{
      id: number;
      status: string;
      payload?: {
        command_id?: string;
        status?: string;
        duration_seconds?: number;
        device_uid?: string;
        liters_target?: number | null;
        flow_rate_liters_per_minute?: number | null;
        batch?: {
          current?: number;
          total?: number | null;
        } | null;
        safety?: {
          manual_override?: boolean;
          ai_review?: {
            decision?: string;
            risk_level?: string;
            reason?: string;
            operator_message?: string;
          };
        };
      };
      ack_payload?: {
        error?: string;
        status?: string;
        relay_state?: string;
        duration_seconds?: number;
        elapsed_seconds?: number;
        remaining_seconds?: number;
        water_spent_liters?: number;
        progress_percent?: number;
        flow_liters_per_minute?: number;
        message?: string;
        first_ack_at?: string;
        received_at?: string;
        ack_history?: Array<{
          status?: string;
          relay_state?: string;
          elapsed_seconds?: number;
          remaining_seconds?: number;
          water_spent_liters?: number;
          progress_percent?: number;
          received_at?: string;
          message?: string;
        }>;
        safety_review?: {
          decision?: string;
          risk_level?: string;
          reason?: string;
          operator_message?: string;
        };
      } | null;
      published_at?: string | null;
      acknowledged_at?: string | null;
      created_at: string;
    }>;
    devices: Array<{
      id: number;
      device_uid: string;
      is_active: boolean;
      registered_is_active?: boolean;
      connection_status?: "online" | "offline";
      seconds_since_seen?: number | null;
      latest_seen_at?: string | null;
      last_seen_at: string | null;
    }>;
    telemetry: Array<{
      id: number;
      device_uid: string;
      soil_moisture_percent: number | null;
      temperature_c: number | null;
      humidity_percent: number | null;
      flow_liters_per_minute: number | null;
      valve_state: string;
      battery_percent: number | null;
      is_test_mode?: boolean;
      raw_payload?: {
        active_command_id?: string;
        elapsed_seconds?: number;
        remaining_seconds?: number;
        water_spent_liters?: number;
        progress_percent?: number;
      };
      has_soil_moisture_sensor?: boolean;
      has_tank_sensor?: boolean;
      tank?: null | {
        capacity_liters: number | null;
        available_liters: number;
        level_percent: number | null;
        sensor_source: string | null;
      };
      captured_at: string;
      created_at: string;
    }>;
    imagery: Array<{
      id: number;
      image_url: string;
      signed_url: string | null;
      source: string;
      captured_at: string | null;
      created_at: string;
      metadata?: {
        originalName?: string;
        mimeType?: string;
        size?: number;
      };
    }>;
    notes: Array<{ id: number; note: string; triage_json: { triage_summary?: string }; created_at: string }>;
    plans: Array<{ id: number; plan_json: { plan_title?: string; decision?: string }; status: string; created_at: string }>;
    decisions: Array<{
      id: number;
      decision_json: {
        headline?: string;
        decision?: string;
        risk_level?: string;
        confidence?: number;
        why?: string;
      };
      evidence_counts?: Record<string, number>;
      status: string;
      created_at: string;
    }>;
    manualPlants?: Array<{
      id: number;
      name: string;
      count: number;
      growth_stage: string;
      notes: string | null;
      source: string;
      created_at: string;
      updated_at: string | null;
    }>;
  };
};

type ActionPlanResult = {
  plan: {
    plan_title: string;
    decision: string;
    decision_reason: string;
    expected_impact: {
      water_saving_liters: number;
      risk_reduction: string;
      manager_value: string;
    };
    tasks: Array<{
      day: number;
      title: string;
      owner: string;
      priority: string;
      evidence: string;
      success_metric: string;
    }>;
    demo_talking_points: string[];
    data_to_collect_next: string[];
  };
};

type JudgeReportResult = {
  report: {
    headline: string;
    one_minute_pitch: string;
    problem: string;
    solution: string;
    ai_value: string[];
    user_value: string[];
    manager_value: string[];
    demo_flow: Array<{
      step: string;
      what_judges_should_notice: string;
    }>;
    current_metrics_story: string;
    risks_and_mitigations: Array<{
      risk: string;
      mitigation: string;
    }>;
    next_30_days: string[];
    winning_angle: string;
  };
};

type FieldTriageResult = {
  triage: {
    triage_summary: string;
    likely_causes: Array<{
      cause: string;
      confidence: number;
      why: string;
    }>;
    immediate_actions: Array<{
      title: string;
      priority: string;
      how_to_do_it: string;
    }>;
    irrigation_adjustment: {
      needed: boolean;
      recommendation: string;
    };
    pest_or_disease_watch: {
      risk_level: string;
      what_to_photograph: string[];
    };
    when_to_escalate: string;
    missing_data: string[];
  };
};

type ImpactResult = {
  impact: {
    maturityScore: number;
    maturityMax: number;
    maturityLabel: string;
    measuredWaterSavingLiters: number;
    latestRecommendedLiters: number;
    latestRecommendedDurationSeconds: number;
    analysisCoverage: number;
    fieldObservationCoverage: number;
    actionPlanCoverage: number;
    automationCoverage: number;
    story: string;
  };
};

type DailyBriefResult = {
  brief: {
    brief_title: string;
    today_summary: string;
    top_priorities: Array<{
      priority: string;
      owner: string;
      urgency: string;
      why_now: string;
    }>;
    lands_to_watch: Array<{
      land_name: string;
      reason: string;
      recommended_next_step: string;
    }>;
    manager_notes: string[];
    demo_value: string;
    missing_data_to_unlock_more_ai: string[];
  };
};

type PortfolioPriorityResult = {
  priority: {
    headline: string;
    portfolio_risk: string;
    manager_summary: string;
    ranked_lands: Array<{
      rank: number;
      land_id: number;
      land_name: string;
      priority: string;
      primary_reason: string;
      recommended_action: string;
      evidence: string[];
      missing_data: string[];
    }>;
    dispatch_plan: Array<{
      owner: string;
      task: string;
      target_land: string;
      time_window: string;
      success_metric: string;
    }>;
    judge_value: string;
    system_gaps: string[];
  };
  prioritySource?: string;
  aiError?: string | null;
  portfolioState: {
    landsCount: number;
    analysesCount: number;
    recommendationsCount: number;
    devicesCount: number;
    telemetryCount: number;
    decisionsCount: number;
  };
  optionalErrors: string[];
};

type WaterBudgetResult = {
  generated_at: string;
  tank: {
    capacity_liters: number;
    available_liters: number;
    current_liters?: number;
    daily_refill_liters?: number;
    reserve_liters: number;
    usable_liters: number;
    remaining_after_plan_liters: number;
    source?: string;
    level_percent?: number | null;
    captured_at?: string | null;
    device_uid?: string | null;
  };
  water_policy?: {
    water_saving_percent: number;
    irrigation_mode?: string;
    irrigation_mode_label?: string;
    source: string;
  };
  summary: {
    lands: number;
    total_required_liters: number;
    total_executable_liters: number;
    total_shortage_liters: number;
    ready_lands: number;
    refill_needed_lands: number;
  };
  allocations: Array<{
    land_id: number;
    land_name: string;
    auto_enabled: boolean;
    required_liters: number;
    executable_liters: number;
    shortage_liters: number;
    daily_average_liters: number;
    interval_days: number;
    irrigation_mode?: string;
    irrigation_mode_label?: string;
    water_saving_percent?: number;
    agronomic_adjustment?: {
      factor: number;
      label: string;
      reasons: string[];
      openMeteo: {
        et0ForecastMm: number;
        et0DailyAverageMm: number;
        precipitationForecastMm: number;
        soilMoisture0To9cm: number | null;
        vaporPressureDeficitKpa: number | null;
      } | null;
      soilGrids: {
        textureClass: string | null;
        sandPercent: number | null;
        siltPercent: number | null;
        clayPercent: number | null;
        phH2o: number | null;
        irrigationFactor: number;
        note: string;
      } | null;
    } | null;
    duration_seconds: number;
    pest_risk: string;
    device_uid: string | null;
    soil_moisture_percent: number | null;
    missing: string[];
    decision: string;
    priority_score: number;
  }>;
  dispatch_order: Array<{
    rank: number;
    land_id: number;
    land_name: string;
    device_uid: string | null;
    allocated_liters: number;
    unmet_liters: number;
    safe_batch_liters: number;
    safe_batch_duration_seconds: number;
    decision: string;
    reason: string;
  }>;
};

type RoiResult = {
  metrics: {
    landsCount: number;
    totalAreaM2: number;
    recommendationsCount: number;
    analysesCount: number;
    fieldNotesCount: number;
    measuredWaterSavingLiters: number;
    latestRecommendedLiters: number;
    latestRecommendedDurationSeconds: number;
    estimatedWaterSavingValue: number;
    estimatedLaborSavingValue: number;
    estimatedTotalValue: number;
  };
  narrative: {
    roi_headline: string;
    farmer_value: string;
    manager_value: string;
    judge_value: string;
    metrics_explained: string[];
    assumptions: string[];
    next_data_to_improve_roi: string[];
  };
};

type ReadinessResult = {
  readiness: {
    readiness_score: number;
    readiness_label: string;
    headline: string;
    judge_story: string;
    ready_capabilities: string[];
    critical_gaps: Array<{
      gap: string;
      why_it_matters: string;
      fix: string;
      priority: string;
    }>;
    next_72_hours: Array<{
      task: string;
      owner: string;
      success_evidence: string;
    }>;
    demo_flow: string[];
  };
  metrics: Record<string, number>;
  missingIntegrations: string[];
};

type DemoRunbookResult = {
  runbook: {
    title: string;
    opening_line: string;
    demo_steps: Array<{
      step: number;
      screen: string;
      action: string;
      talk_track: string;
      evidence_to_show: string;
      judge_should_notice: string;
    }>;
    fallback_if_live_ai_quota_fails: string[];
    honest_gaps: string[];
    closing_line: string;
  };
  source: string;
  aiError: string | null;
  metrics: Record<string, number>;
  optionalErrors: string[];
};

type SensorInsightResult = {
  insight: {
    headline: string;
    sensor_confidence: number;
    irrigation_decision: string;
    decision_reason: string;
    anomaly_watch: Array<{
      signal: string;
      risk: string;
      evidence: string;
      next_check: string;
    }>;
    farmer_actions: Array<{
      title: string;
      priority: string;
      how: string;
    }>;
    manager_value: string;
    missing_data: string[];
  };
  telemetryAvailable: boolean;
  telemetryError: string | null;
  telemetryCount: number;
};

type WeatherRiskResult = {
  risk: {
    headline: string;
    weather_risk: string;
    irrigation_adjustment: string;
    confidence: number;
    why: string;
    rain_effect: {
      forecast_rain_mm: number;
      recommendation: string;
    };
    heat_or_humidity_watch: Array<{
      signal: string;
      risk: string;
      action: string;
    }>;
    farmer_actions: Array<{
      title: string;
      priority: string;
      time_window: string;
    }>;
    manager_value: string;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
  telemetryAvailable: boolean;
  telemetryError: string | null;
};

type OperatorChecklistResult = {
  checklist: {
    title: string;
    overall_priority: string;
    operator_summary: string;
    checklist: Array<{
      step: number;
      task: string;
      owner: string;
      priority: string;
      time_window: string;
      evidence: string;
      done_when: string;
    }>;
    do_not_do: string[];
    manager_note: string;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
};

type PestResponseResult = {
  response: {
    headline: string;
    pest_risk: string;
    red_palm_weevil_watch: {
      suspected: boolean;
      confidence: number;
      evidence: string[];
    };
    immediate_actions: Array<{
      title: string;
      priority: string;
      owner: string;
      how: string;
      done_when: string;
    }>;
    photo_evidence_needed: string[];
    irrigation_caution: string;
    escalation: {
      needed: boolean;
      when: string;
      who: string;
    };
    manager_value: string;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
};

type LandQuestionResult = {
  answer: {
    answer: string;
    confidence: number;
    evidence_used: Array<{
      source: string;
      detail: string;
    }>;
    recommended_next_step: string;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
};

type AgentRunResult = {
  agent: {
    agent_name: string;
    intent: string;
    decision: string;
    confidence: number;
    summary: string;
    tool_trace: Array<{
      tool: string;
      status: string;
      result: string;
    }>;
    proposed_command: {
      allowed_to_prepare: boolean;
      requires_admin_approval: boolean;
      mqtt_topic: string;
      payload: {
        land_id: number;
        device_uid: string;
        status: string;
        duration_seconds: number;
        liters_target: number;
        reason: string;
      };
    };
    safety_checks: Array<{
      name: string;
      status: string;
      details: string;
    }>;
    next_actions: Array<{
      owner: string;
      action: string;
      priority: string;
    }>;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
};

type DemoWorkflowCheckResult = {
  score: number;
  label: string;
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    status: "ready" | "partial" | "missing" | "assumed";
    proof: string;
    gap: string;
    action: string;
  }>;
  blocking: Array<{
    id: string;
    title: string;
    status: string;
    proof: string;
    gap: string;
    action: string;
  }>;
};

type IdealDemoRunResult = {
  mode: string;
  land: {
    id: number;
    name: string;
    area_m2: number;
    auto_irrigation_enabled: boolean;
  };
  readiness: {
    can_prepare_command: boolean;
    can_complete_irrigation: boolean;
    needs_refill_liters: number;
    pest_risk: string;
    missing: string[];
  };
  plants: Array<{
    name: string;
    count: number;
    source?: string;
  }>;
  weather: null | {
    forecastRainMm?: number;
    currentRainMm?: number;
    temperatureC?: number;
    humidity?: number;
  };
  irrigation: {
    waterSavingPercent?: number;
    waterSavingFactor?: number;
    irrigationMode?: string;
    irrigationModeLabel?: string;
    irrigationModeReason?: string;
    rawBaseLiters?: number;
    rawTotalLitersPerIrrigation?: number;
    totalLitersPerDay: number;
    dailyAverageLiters?: number;
    totalLitersPerIrrigation: number;
    executableLiters: number;
    tankShortageLiters: number;
    irrigationIntervalDays: number;
    recommendedIrrigationDurationSeconds: number;
  };
  tank: {
    capacity_liters: number;
    available_liters: number;
    reserve_liters: number;
    usable_liters: number | null;
  };
  device: {
    uid: string;
    topic: string;
    assumed_for_demo?: boolean;
    last_seen_at?: string | null;
  };
  command_preview: null | {
    land_id: number;
    status: string;
    duration_seconds: number;
    liters_target: number;
    dry_run: boolean;
  };
  batches: Array<{
    batch: number;
    wait_minutes_before_start: number;
    duration_seconds: number;
    liters: number;
    requires_operator_check_after: boolean;
  }>;
  timeline: Array<{
    step: number;
    title: string;
    result: string;
  }>;
};

type AutopilotScanResult = {
  summary: string;
  score: number;
  portfolio: {
    lands: number;
    readyToPrepare: number;
    blocked: number;
    needsHumanReview: number;
    autoExecuted?: number;
  };
  decisions: Array<{
    land_id: number;
    land_name: string;
    decision: string;
    auto_enabled?: boolean;
    auto_execution?: null | {
      status: string;
      commandId?: number;
      commandUuid?: string;
      topic?: string;
      error?: string;
    };
    priority: string;
    confidence: number;
    reason: string;
    water: null | {
      liters_per_irrigation: number;
      executable_liters: number;
      safe_batch_liters: number;
      duration_seconds: number;
      full_duration_seconds: number;
      interval_days: number;
      irrigation_mode?: string;
      irrigation_mode_label?: string;
      tank_shortage_liters: number;
      batch_plan?: Array<{
        batch: number;
        start_after_minutes: number;
        duration_seconds: number;
        liters_target: number;
        requires_review_between_batches: boolean;
      }>;
    };
    device: null | {
      uid: string;
      topic: string;
    };
    blockers: string[];
    warnings: string[];
    next_action: string;
    evidence?: {
      tank?: {
        capacity_liters?: number | null;
        available_liters?: number | null;
        reserve_liters?: number | null;
        source?: string;
        level_percent?: number | null;
        captured_at?: string | null;
        device_uid?: string | null;
        water_saving_percent?: number | null;
        irrigation_mode?: string | null;
      };
      soil_moisture?: {
        percent?: number | null;
        threshold_percent?: number | null;
        auto_trigger?: boolean;
        captured_at?: string | null;
      };
    };
  }>;
};

type EvidenceReportResult = {
  report: {
    title: string;
    executive_summary: string;
    evidence_score: number;
    proof_points: Array<{
      claim: string;
      evidence: string;
      strength: string;
    }>;
    timeline: Array<{
      event: string;
      source: string;
      timestamp: string;
      why_it_matters: string;
    }>;
    current_decision: {
      decision: string;
      reason: string;
    };
    judge_demo_script: string[];
    missing_evidence: string[];
    next_best_step: string;
  };
  evidenceCounts: Record<string, number>;
};

type UnifiedDecisionResult = {
  decision: {
    headline: string;
    decision: string;
    confidence: number;
    risk_level: string;
    why: string;
    evidence_used: Array<{
      source: string;
      finding: string;
      strength: string;
    }>;
    farmer_next_actions: Array<{
      title: string;
      priority: string;
      time_window: string;
      success_check: string;
    }>;
    automation: {
      allowed: boolean;
      reason: string;
      suggested_duration_seconds: number;
      requires_human_approval: boolean;
    };
    manager_view: {
      judge_story: string;
      business_value: string;
      weakest_link: string;
    };
    missing_data: string[];
  };
  evidenceCounts: Record<string, number>;
  optionalErrors: string[];
  decisionSource?: string;
  aiError?: string | null;
  saved?: null | { decisionId: number | null };
  saveError?: string | null;
};

type IrrigationScheduleResult = {
  schedule: {
    title: string;
    mode: string;
    confidence: number;
    summary: string;
    water_budget: {
      liters_next_24h: number;
      daily_average_liters?: number;
      liters_per_irrigation?: number;
      executable_liters?: number;
      tank_available_liters?: number | null;
      tank_reserve_liters?: number;
      usable_tank_liters?: number | null;
      tank_shortage_liters?: number;
      can_complete_irrigation?: boolean;
      irrigation_interval_days?: number;
      irrigation_mode?: string;
      irrigation_mode_label?: string;
      rain_deduction_liters: number;
      source_recommendation_id: number;
    };
    slots: Array<{
      slot: number;
      start_after_minutes: number;
      duration_seconds: number;
      valve_status: string;
      reason: string;
      send_mqtt: boolean;
      requires_operator_approval: boolean;
    }>;
    safety_checks: string[];
    operator_message: string;
    manager_value: string;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
  evidenceCounts: Record<string, number>;
  saved: null | { scheduleId: number | null };
  saveError: string | null;
};

type DeviceProvisioningResult = {
  land: {
    id: number;
    name: string;
    crop_hint: string | null;
  };
  device: {
    id: number;
    land_id: number;
    device_uid: string;
    mqtt_topic_command: string;
    mqtt_topic_ack: string;
    relay_pin: number;
    is_active: boolean;
    last_seen_at: string | null;
    created_at: string;
  };
  topics: {
    command: string;
    ack: string;
    telemetryEndpoint: string;
    ackEndpoint: string;
  };
  firmwareConfig: string;
  mqttConfigured: boolean;
  accessories?: Record<string, unknown>;
  accessoriesPersisted?: boolean;
};

type HardwareReadinessResult = {
  readiness: {
    headline: string;
    readiness: string;
    score: number;
    operator_summary: string;
    checks: Array<{
      name: string;
      status: string;
      evidence: string;
      fix: string;
    }>;
    safe_demo_action: {
      allowed: boolean;
      action: string;
      reason: string;
    };
    next_steps: string[];
    manager_value: string;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
  evidenceCounts: Record<string, number>;
  configuration: {
    mqttConfigured: boolean;
    telemetryTableReady: boolean;
  };
};

type WorkOrdersResult = {
  workPlan: {
    headline: string;
    summary: string;
    work_orders: Array<{
      title: string;
      owner_role: string;
      priority: string;
      due_in_hours: number;
      why: string;
      how: string;
      success_check: string;
      evidence: string[];
    }>;
    manager_value: string;
    missing_data: string[];
  };
  source: string;
  aiError: string | null;
  saved: null | { count: number; ids: number[] };
  saveError: string | null;
  evidenceCounts: Record<string, number>;
};

type PhotoMissionResult = {
  mission: {
    mission_title: string;
    capture_priority: string;
    why_now: string;
    shots: Array<{
      title: string;
      device: string;
      distance: string;
      angle: string;
      target: string;
      success_criteria: string;
    }>;
    red_palm_weevil_focus: string[];
    avoid: string[];
    minimum_set_for_demo: string[];
    after_capture_next_step: string;
  };
};

function polygonToGeojson(points: [number, number][]) {
  if (points.length < 3) return "";
  const coordinates = points.map(([pointLat, pointLon]) => [pointLon, pointLat]);
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  const closed = first[0] === last[0] && first[1] === last[1]
    ? coordinates
    : [...coordinates, first];

  return JSON.stringify({
    type: "Polygon",
    coordinates: [closed]
  });
}

function geojsonToPolygon(geojson?: Land["boundary_geojson"]): [number, number][] {
  const ring = geojson?.coordinates?.[0];
  if (!Array.isArray(ring)) return [];
  const points = ring
    .map((coordinate) => {
      const [lon, lat] = coordinate;
      return [lat, lon] as [number, number];
    })
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));

  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      return points.slice(0, -1);
    }
  }

  return points;
}

function calculatePolygonAreaM2(points: [number, number][]) {
  if (points.length < 3) return 0;
  const radius = 6378137;
  const radians = Math.PI / 180;
  let area = 0;

  for (let i = 0; i < points.length; i += 1) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[(i + 1) % points.length];
    area += (lon2 - lon1) * radians * (2 + Math.sin(lat1 * radians) + Math.sin(lat2 * radians));
  }

  return Math.abs((area * radius * radius) / 2);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function translateGrowthStage(stage: unknown) {
  const value = String(stage ?? "").toLowerCase();
  const labels: Record<string, string> = {
    mature: "ناضج",
    fruiting: "مثمر",
    vegetative: "نمو خضري",
    seedling: "بادرة صغيرة",
    flowering: "مزهر",
    unknown: "غير محدد"
  };
  return labels[value] ?? String(stage ?? "غير محدد");
}

function translateRiskLevel(level: unknown) {
  const value = String(level ?? "").toLowerCase();
  const labels: Record<string, string> = {
    none: "لا يوجد خطر واضح",
    low: "منخفض",
    medium: "متوسط",
    high: "عال",
    severe: "حرج",
    unknown: "غير محدد"
  };
  return labels[value] ?? String(level ?? "غير محدد");
}

function irrigationModeLabel(mode: unknown) {
  const found = IRRIGATION_MODE_OPTIONS.find((item) => item.id === String(mode));
  return found?.label ?? IRRIGATION_MODE_OPTIONS.find((item) => item.id === "medium_productivity")?.label ?? "إنتاجية متوسطة";
}

function irrigationModeDescription(mode: unknown) {
  const found = IRRIGATION_MODE_OPTIONS.find((item) => item.id === String(mode));
  return found?.description ?? "يحسب النظام كمية الري حسب هدف التشغيل المختار.";
}

function plantRows(summary: unknown) {
  const record = recordFromUnknown(summary);
  const plants = Array.isArray(record.plants) ? record.plants : [];
  return plants.map((item) => {
    const plant = recordFromUnknown(item);
    return {
      name: String(plant.name ?? "نبات غير محدد"),
      count: Number(plant.count ?? 0),
      confidence: Number(plant.count_confidence ?? 0),
      stage: translateGrowthStage(plant.growth_stage),
      notes: String(plant.notes ?? "")
    };
  });
}

function pestView(summary: unknown) {
  const pest = recordFromUnknown(summary);
  const redPalmWeevil = recordFromUnknown(pest.red_palm_weevil_indicators);
  const suspected = Array.isArray(pest.suspected_pests) ? pest.suspected_pests : [];

  return {
    detected: Boolean(pest.detected),
    risk: translateRiskLevel(pest.risk_level),
    redPalmWeevilDetected: Boolean(redPalmWeevil.detected),
    redPalmWeevilConfidence: Number(redPalmWeevil.confidence ?? 0),
    suspectedNames: suspected.map((item) => String(recordFromUnknown(item).name ?? "")).filter(Boolean)
  };
}

export default function Home() {
  const supabaseClient = useMemo(() => createSupabaseBrowser(), []);
  const [authReady, setAuthReady] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentProfile, setCurrentProfile] = useState<AppProfile | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<"farmer" | "admin" | "operator">("farmer");
  const [selectedAdminUserId, setSelectedAdminUserId] = useState("");
  const [selectedAdminLandId, setSelectedAdminLandId] = useState("");
  const [adminEspLandId, setAdminEspLandId] = useState("");
  const [adminEspBindLandId, setAdminEspBindLandId] = useState("");
  const [adminEspDeviceUid, setAdminEspDeviceUid] = useState("");
  const [adminEspRelayPin, setAdminEspRelayPin] = useState("26");
  const [adminEspPumpFlow, setAdminEspPumpFlow] = useState("1");
  const [adminEspSoilSensorModel, setAdminEspSoilSensorModel] = useState("HW-030");
  const [adminEspTankSensorModel, setAdminEspTankSensorModel] = useState("HW-038");
  const [adminEspRelayModel, setAdminEspRelayModel] = useState("5V relay module");
  const [adminEspPumpModel, setAdminEspPumpModel] = useState("USB pump");
  const [adminEspNotes, setAdminEspNotes] = useState("");
  const [adminEspHasSoilSensor, setAdminEspHasSoilSensor] = useState(true);
  const [adminEspHasTankSensor, setAdminEspHasTankSensor] = useState(true);
  const [adminEspHasRelay, setAdminEspHasRelay] = useState(true);
  const [adminEspHasPump, setAdminEspHasPump] = useState(true);
  const [adminEspHasFlowMeter, setAdminEspHasFlowMeter] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [setupDoctor, setSetupDoctor] = useState<SetupDoctor | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [pottedPlantName, setPottedPlantName] = useState("");
  const [pottedPlantLocation, setPottedPlantLocation] = useState("");
  const [pottedPlantNotes, setPottedPlantNotes] = useState("");
  const [pottedPlantResult, setPottedPlantResult] = useState<PottedPlantAnalysisResult | null>(null);
  const [pottedPlants, setPottedPlants] = useState<PottedPlant[]>([]);
  const [selectedPottedPlantId, setSelectedPottedPlantId] = useState("");
  const [iotDeviceInventory, setIotDeviceInventory] = useState<IotDeviceInventoryResult | null>(null);
  const [lat, setLat] = useState("33.3152");
  const [lon, setLon] = useState("44.3661");
  const [areaM2, setAreaM2] = useState("1000");
  const [cropHint, setCropHint] = useState("date palm");
  const [flowRate, setFlowRate] = useState("10");
  const [tankCapacityLiters, setTankCapacityLiters] = useState("2000");
  const [tankCurrentLiters, setTankCurrentLiters] = useState("2000");
  const [tankDailyRefillLiters, setTankDailyRefillLiters] = useState("0");
  const [tankReserveLiters, setTankReserveLiters] = useState("80");
  const [waterSavingPercent, setWaterSavingPercent] = useState("70");
  const [autoMoistureThresholdPercent, setAutoMoistureThresholdPercent] = useState("35");
  const [irrigationMode, setIrrigationMode] = useState<IrrigationModeOption>("medium_productivity");
  const [autoIrrigationEnabled, setAutoIrrigationEnabled] = useState(false);
  const [demoTankLiters, setDemoTankLiters] = useState(2000);
  const [demoIrrigationRunning, setDemoIrrigationRunning] = useState(false);
  const [manualIrrigationDurationSeconds, setManualIrrigationDurationSeconds] = useState("300");
  const [manualIrrigationLitersTarget, setManualIrrigationLitersTarget] = useState("50");
  const [deviceUid, setDeviceUid] = useState("");
  const [manualPlantName, setManualPlantName] = useState("Date Palm");
  const [manualPlantCount, setManualPlantCount] = useState("1");
  const [manualPlantStage, setManualPlantStage] = useState("mature");
  const [manualPlantNotes, setManualPlantNotes] = useState("");
  const [cropCatalog, setCropCatalog] = useState<CropCatalogItem[]>([]);
  const [selectedCropCatalogId, setSelectedCropCatalogId] = useState("date_palm");
  const [landName, setLandName] = useState("مزرعة النخيل");
  const [landGeojson, setLandGeojson] = useState("");
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [lands, setLands] = useState<Land[]>([]);
  const [deletedLands, setDeletedLands] = useState<Land[]>([]);
  const [selectedLandId, setSelectedLandId] = useState("");
  const [place, setPlace] = useState<PlaceInfo | null>(null);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [photoMission, setPhotoMission] = useState<PhotoMissionResult | null>(null);
  const [advisory, setAdvisory] = useState<AdvisoryResult | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [landOps, setLandOps] = useState<LandOps | null>(null);
  const [actionPlan, setActionPlan] = useState<ActionPlanResult | null>(null);
  const [unifiedDecision, setUnifiedDecision] = useState<UnifiedDecisionResult | null>(null);
  const [irrigationSchedule, setIrrigationSchedule] = useState<IrrigationScheduleResult | null>(null);
  const [deviceProvisioning, setDeviceProvisioning] = useState<DeviceProvisioningResult | null>(null);
  const [hardwareReadiness, setHardwareReadiness] = useState<HardwareReadinessResult | null>(null);
  const [workOrders, setWorkOrders] = useState<WorkOrdersResult | null>(null);
  const [sensorInsight, setSensorInsight] = useState<SensorInsightResult | null>(null);
  const [weatherRisk, setWeatherRisk] = useState<WeatherRiskResult | null>(null);
  const [operatorChecklist, setOperatorChecklist] = useState<OperatorChecklistResult | null>(null);
  const [pestResponse, setPestResponse] = useState<PestResponseResult | null>(null);
  const [agentMessage, setAgentMessage] = useState("افحص الأرض وجهز قرار ري إذا الخزان يكفي والجهاز جاهز");
  const [agentRun, setAgentRun] = useState<AgentRunResult | null>(null);
  const [landQuestion, setLandQuestion] = useState("ليش القرار الحالي يحتاج مراجعة؟");
  const [landQuestionAnswer, setLandQuestionAnswer] = useState<LandQuestionResult | null>(null);
  const [evidenceReport, setEvidenceReport] = useState<EvidenceReportResult | null>(null);
  const [judgeReport, setJudgeReport] = useState<JudgeReportResult | null>(null);
  const [fieldNote, setFieldNote] = useState("");
  const [fieldTriage, setFieldTriage] = useState<FieldTriageResult | null>(null);
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [dailyBrief, setDailyBrief] = useState<DailyBriefResult | null>(null);
  const [portfolioPriority, setPortfolioPriority] = useState<PortfolioPriorityResult | null>(null);
  const [waterBudget, setWaterBudget] = useState<WaterBudgetResult | null>(null);
  const [waterCostPerLiter, setWaterCostPerLiter] = useState("0.001");
  const [laborCostPerInspection, setLaborCostPerInspection] = useState("5");
  const [avoidedInspections, setAvoidedInspections] = useState("0");
  const [roi, setRoi] = useState<RoiResult | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [demoRunbook, setDemoRunbook] = useState<DemoRunbookResult | null>(null);
  const [demoWorkflowCheck, setDemoWorkflowCheck] = useState<DemoWorkflowCheckResult | null>(null);
  const [idealDemoRun, setIdealDemoRun] = useState<IdealDemoRunResult | null>(null);
  const [autopilotScan, setAutopilotScan] = useState<AutopilotScanResult | null>(null);

  useEffect(() => {
    const savedFlowRate = window.localStorage.getItem("agriai:pump-flow-rate-lpm");
    if (savedFlowRate && Number(savedFlowRate) > 0) {
      setFlowRate(savedFlowRate);
    }
  }, []);

  useEffect(() => {
    if (Number(flowRate) > 0) {
      window.localStorage.setItem("agriai:pump-flow-rate-lpm", flowRate);
    }
  }, [flowRate]);
  const [workspaceMode, setWorkspaceMode] = useState<"user" | "admin">("user");
  const [activeSection, setActiveSection] = useState<ActiveSection>("assets");
  const [opsView, setOpsView] = useState<OpsView>("overview");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [tankSyncSource, setTankSyncSource] = useState("");
  const lastDeviceToastRef = useRef("");
  const deviceToastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then(setHealth)
      .catch((err) => setError(String(err)));
    fetch("/api/crop-catalog")
      .then((response) => response.json())
      .then((payload) => setCropCatalog(payload.crops ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;

    supabaseClient.auth.getSession()
      .then(({ data }) => {
        if (!active) return;
        const user = data.session?.user ?? null;
        setCurrentUser(user);
        if (user) {
          loadCurrentProfile(user.id);
        }
      })
      .catch((error) => {
        if (!active) return;
        setError(`تعذر تجهيز تسجيل الدخول: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });

    const { data } = supabaseClient.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      const user = session?.user ?? null;
      setCurrentUser(user);
      setCurrentProfile(null);
      if (user) {
        loadCurrentProfile(user.id);
      }
      setAuthReady(true);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabaseClient]);

  useEffect(() => {
    if (!authReady || !currentUser) return;
    loadLands(currentUser.id);
    loadDeletedLands(currentUser.id);
    loadPottedPlants(currentUser.id);
    loadDashboard();
    loadIotDevices();
  }, [authReady, currentUser?.id, currentProfile?.role]);

  useEffect(() => {
    if (currentProfile?.role === "admin") {
      loadAdminUsers();
    }
  }, [currentProfile?.role]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadPlace();
    }, 700);

    return () => window.clearTimeout(timer);
  }, [lat, lon]);

  useEffect(() => {
    const message = error || status;
    if (!message) return;

    const type: Toast["type"] = error
      ? "error"
      : status.startsWith("جاري")
        ? "info"
        : "success";
    const id = Date.now();

    setToast({ id, type, message });
    const timer = window.setTimeout(() => {
      setToast((current) => current?.id === id ? null : current);
    }, type === "error" ? 6200 : 4200);

    return () => window.clearTimeout(timer);
  }, [status, error]);

  useEffect(() => {
    if (activeSection !== "ops" || !selectedLandId || !landOps) return;

    const latestCommand = landOps.recent.commands[0];
    const liveStatuses = new Set(["queued", "published", "running"]);
    const ackStatus = String(latestCommand?.ack_payload?.status ?? "").toLowerCase();
    const shouldPoll = Boolean(
      latestCommand
      && (
        liveStatuses.has(String(latestCommand.status ?? "").toLowerCase())
        || ["started", "progress"].includes(ackStatus)
        || landOps.recent.telemetry.some((reading) => reading.valve_state === "ON")
      )
    );

    if (!shouldPoll) return;

    const timer = window.setInterval(() => {
      loadLandOps(selectedLandId);
    }, 3000);

    return () => window.clearInterval(timer);
  }, [activeSection, selectedLandId, landOps?.recent.commands[0]?.id, landOps?.recent.commands[0]?.status, landOps?.recent.commands[0]?.ack_payload?.status]);

  useEffect(() => {
    if (!demoIrrigationRunning) return;

    const timer = window.setInterval(() => {
      setDemoTankLiters((current) => {
        const flowPerSecond = Math.max(0.01, Number(flowRate) / 60);
        const reserve = Math.max(0, Number(tankReserveLiters) || 0);
        const next = Math.max(reserve, current - flowPerSecond);
        if (next <= reserve + 0.01) {
          window.setTimeout(() => setDemoIrrigationRunning(false), 0);
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [demoIrrigationRunning, flowRate, tankReserveLiters]);

  const missing = useMemo(() => {
    if (!health) return [];
    return Object.entries(health.configured)
      .filter(([, ready]) => !ready)
      .map(([key]) => key);
  }, [health]);

  const mapCenter = useMemo<[number, number]>(() => {
    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    return [
      Number.isFinite(parsedLat) ? parsedLat : 33.3152,
      Number.isFinite(parsedLon) ? parsedLon : 44.3661
    ];
  }, [lat, lon]);

  const isAdmin = currentProfile?.role === "admin";
  const legacyDemoVisible = false as boolean;
  const selectionReady = polygonPoints.length >= 3;
  const selectedLand = lands.find((land) => String(land.id) === selectedLandId);
  const selectedPottedPlant = pottedPlants.find((plant) => String(plant.id) === selectedPottedPlantId);
  const esp32Online = landOps?.summary.deviceConnectionStatus === "online";
  const esp32ConnectionMessage = landOps?.summary.deviceConnectionStatus === "online"
    ? ""
    : landOps?.summary.deviceConnectionStatus === "offline"
      ? "ESP32 غير متصل حالياً. شغّل القطعة وانتظر ظهور telemetry حديثة قبل إرسال الري."
      : "لا يوجد ESP32 مسجل لهذه الأرض. جهّز الجهاز وانتظر أول telemetry قبل إرسال الري.";
  const demoTankCapacity = Math.max(1, Number(tankCapacityLiters) || 2000);
  const dailyRefillLiters = Math.max(0, Number(tankDailyRefillLiters) || 0);
  const demoTankReserve = Math.max(0, Number(tankReserveLiters) || 0);
  const demoTankPercent = Math.max(0, Math.min(100, (demoTankLiters / demoTankCapacity) * 100));
  const demoUsableLiters = Math.max(0, demoTankLiters - demoTankReserve);
  const latestAutopilotWater = autopilotScan?.decisions?.[0]?.water ?? null;
  const demoPlannedLiters = Math.max(0, Number(
    idealDemoRun?.irrigation?.totalLitersPerIrrigation ??
    latestAutopilotWater?.liters_per_irrigation ??
    waterBudget?.summary?.total_required_liters ??
    480
  ));
  const demoRawLiters = Math.max(0, Number(
    idealDemoRun?.irrigation?.rawTotalLitersPerIrrigation ??
    demoPlannedLiters
  ));
  const demoTargetLiters = Math.max(0, Number(
    idealDemoRun?.irrigation?.executableLiters ??
    latestAutopilotWater?.safe_batch_liters ??
    Math.min(demoPlannedLiters, demoUsableLiters)
  ));
  const demoIntervalDays = Math.max(1, Number(
    idealDemoRun?.irrigation?.irrigationIntervalDays ??
    latestAutopilotWater?.interval_days ??
    3
  ));
  const demoSavingPercent = Math.max(40, Math.min(100, Number(
    idealDemoRun?.irrigation?.waterSavingPercent ??
    waterBudget?.water_policy?.water_saving_percent ??
    waterSavingPercent ??
    70
  )));
  const selectedIrrigationMode = IRRIGATION_MODE_OPTIONS.find((item) => item.id === irrigationMode) ?? IRRIGATION_MODE_OPTIONS[1];
  const selectedOpsView = OPS_VIEW_META[opsView];
  const latestRecommendation = landOps?.recent.recommendations?.[0] ?? null;
  const configuredFlowRateLpm = Math.max(0.1, Number(flowRate) || 10);
  const latestRecommendationStoredDuration = Number(latestRecommendation?.recommended_duration_seconds ?? 0);
  const latestRecommendationLiters = Number(latestRecommendation?.total_liters_per_day ?? 0);
  const latestRecommendationDuration = latestRecommendationLiters > 0
    ? Math.ceil((latestRecommendationLiters / configuredFlowRateLpm) * 60)
    : latestRecommendationStoredDuration;
  const latestRecommendationSafeDuration = Math.min(1800, Math.max(0, latestRecommendationDuration));
  const latestRecommendationSafeLiters = latestRecommendationDuration > 0
    ? latestRecommendationLiters * (latestRecommendationSafeDuration / latestRecommendationDuration)
    : 0;
  const manualTargetLiters = Math.max(0, Number(manualIrrigationLitersTarget) || 0);
  const manualCalculatedDurationSeconds = manualTargetLiters > 0
    ? Math.ceil((manualTargetLiters / configuredFlowRateLpm) * 60)
    : 0;
  const pottedManualSuggestedLiters = selectedPottedPlant
    ? Math.max(0, Number(
      latestRecommendation?.total_liters_per_day
      ?? pottedPlantResult?.commandPreview?.liters_target
      ?? selectedPottedPlant.command_preview?.liters_target
      ?? 0
    ))
    : 0;
  const manualRecommendationLiters = pottedManualSuggestedLiters > 0 ? pottedManualSuggestedLiters : manualTargetLiters;
  const manualRecommendationDurationSeconds = manualRecommendationLiters > 0
    ? Math.ceil((manualRecommendationLiters / configuredFlowRateLpm) * 60)
    : 0;
  const latestSensorReading = landOps?.recent.telemetry?.[0] ?? null;
  const latestSoilMoisture = latestSensorReading?.soil_moisture_percent;
  const autoMoistureThreshold = Math.max(5, Math.min(80, Number(autoMoistureThresholdPercent) || 35));
  const soilMoistureAutoTrigger = latestSoilMoisture !== null
    && latestSoilMoisture !== undefined
    && Number(latestSoilMoisture) < autoMoistureThreshold;
  const latestTank = latestSensorReading?.tank ?? null;
  const latestTankLiters = latestTank?.available_liters ?? Number(tankCurrentLiters || 0);
  const selectedWaterAllocation = waterBudget?.allocations.find((item) => String(item.land_id) === String(selectedLandId))
    ?? waterBudget?.allocations[0]
    ?? null;
  const periodicIntervalDays = Number(
    result?.irrigation.irrigationIntervalDays
    ?? selectedWaterAllocation?.interval_days
    ?? 1
  );
  const automaticReady = Boolean(
    selectedLandId
    && latestRecommendation
    && esp32Online
    && autoIrrigationEnabled
    && soilMoistureAutoTrigger
    && latestTankLiters >= Math.max(0, latestRecommendationLiters)
  );
  const selectedAgronomicAdjustment = selectedWaterAllocation?.agronomic_adjustment ?? null;

  useEffect(() => {
    if (!selectedPottedPlantId || pottedManualSuggestedLiters <= 0) return;
    const currentLiters = Number(manualIrrigationLitersTarget);
    const shouldUsePottedSuggestion = !Number.isFinite(currentLiters) || currentLiters <= 0 || currentLiters > 2;
    if (!shouldUsePottedSuggestion) return;

    const nextLiters = Number(pottedManualSuggestedLiters.toFixed(3));
    const nextDuration = Math.max(1, Math.ceil((nextLiters / configuredFlowRateLpm) * 60));
    setManualIrrigationLitersTarget(String(nextLiters));
    setManualIrrigationDurationSeconds(String(nextDuration));
  }, [selectedPottedPlantId, pottedManualSuggestedLiters, configuredFlowRateLpm, manualIrrigationLitersTarget]);

  const demoShortageLiters = Math.max(0, demoTargetLiters - demoUsableLiters);
  const opsRunwayTitle = opsView === "overview"
    ? "ابدأ بفحص واحد"
    : opsView === "recommendations"
      ? "ثبت كمية الري قبل التشغيل"
      : opsView === "auto"
        ? "الري التلقائي يحتاج شروط أمان واضحة"
        : opsView === "manual"
          ? "تشغيل يدوي بصلاحية Admin"
          : opsView === "hardware"
            ? "اختبر القطعة قبل أي أمر ماء"
            : opsView === "live"
              ? "راقب ACK والتنفيذ لحظة بلحظة"
              : "اسأل AI من سجلات الأرض فقط";
  const opsRunwayDetail = opsView === "overview"
    ? "الفحص الذكي يلخص الأرض، الخزان، الجهاز، وأقرب مانع تشغيل بدون إرسال MQTT."
    : opsView === "recommendations"
      ? "احسب الماء حسب مود الري والخزان، ثم أنشئ جدولة تدعم أي أمر لاحق."
      : opsView === "auto"
        ? "Autopilot لا يرسل أمرا إلا إذا التوصية موجودة، الخزان يكفي، والجهاز متصل."
        : opsView === "manual"
          ? "هذا المسار يتجاوز مراجعة AI، لذلك استخدمه فقط أثناء مراقبة المضخة والصمام."
          : opsView === "hardware"
            ? "أرسل اختبارا قصيرا حتى تتأكد أن ESP32 والـ Relay يستقبلان الأوامر."
            : opsView === "live"
              ? "لا تعتبر الري منفذا إلا بعد وصول ACK أو telemetry بنفس رقم الأمر."
              : "هذه الصفحة للتفسير، التقارير، خطط العمل، وتحليل النواقص بدون ازدحام صفحة الري.";
  const opsReadinessSteps = [
    {
      label: "الأرض",
      value: selectedLandId ? landOps?.land.name ?? selectedLand?.name ?? "مختارة" : "غير مختارة",
      ready: Boolean(selectedLandId)
    },
    {
      label: "توصية الري",
      value: latestRecommendation
        ? `${Number(latestRecommendation.total_liters_per_day ?? 0).toFixed(1)} L`
        : "غير موجودة",
      ready: Boolean(latestRecommendation)
    },
    {
      label: "ESP32",
      value: selectedLandId
        ? landOps?.summary.deviceConnectionStatus === "online"
          ? "متصل الآن"
          : landOps?.summary.deviceConnectionStatus === "offline"
            ? "غير متصل"
            : "غير مسجل"
        : "بانتظار أرض",
      ready: Boolean(selectedLandId && esp32Online)
    },
    {
      label: "الخزان",
      value: `${Number(tankCurrentLiters || 0).toFixed(0)} / ${Number(tankCapacityLiters || 0).toFixed(0)} L`,
      ready: Number(tankCurrentLiters || 0) > Number(tankReserveLiters || 0)
    }
  ];
  const smartDemoSummary = useMemo(() => {
    const firstDecision = autopilotScan?.decisions?.[0];
    const readyToPrepare = autopilotScan?.portfolio.readyToPrepare ?? 0;
    const blocked = autopilotScan?.portfolio.blocked ?? 0;
    const autoExecuted = autopilotScan?.portfolio.autoExecuted ?? 0;
    const latestCommand = landOps?.recent.commands?.[0];
    const biggestBlocker = firstDecision?.blockers?.[0]
      ?? demoWorkflowCheck?.blocking?.[0]?.title
      ?? firstDecision?.warnings?.[0]
      ?? "لا توجد نقطة توقف حرجة حالياً";

    return {
      readinessScore: autopilotScan?.score ?? demoWorkflowCheck?.score ?? 0,
      readinessLabel: autopilotScan
        ? blocked > 0 ? "يحتاج تدخل" : readyToPrepare > 0 ? "جاهز للتشغيل" : "قيد المراجعة"
        : demoWorkflowCheck?.label ?? "لم يتم الفحص",
      waterTarget: firstDecision?.water?.liters_per_irrigation ?? demoTargetLiters,
      safeBatch: firstDecision?.water?.safe_batch_liters ?? Math.min(demoTargetLiters, demoUsableLiters),
      tankUsable: demoUsableLiters,
      tankShortage: firstDecision?.water?.tank_shortage_liters ?? demoShortageLiters,
      activeDevices: landOps?.summary.activeDevices ?? 0,
      commands: landOps?.summary.commandsCount ?? 0,
      latestCommandStatus: latestCommand?.status ?? "لا يوجد أمر",
      autoExecuted,
      biggestBlocker
    };
  }, [autopilotScan, demoWorkflowCheck, landOps, demoTargetLiters, demoUsableLiters, demoShortageLiters]);

  const agentDecisionFlow = useMemo(() => {
    const decision = autopilotScan?.decisions?.[0];
    const workflowBlocker = demoWorkflowCheck?.blocking?.[0];

    if (!decision) {
      return {
        status: demoWorkflowCheck ? demoWorkflowCheck.label : "بانتظار الفحص",
        headline: demoWorkflowCheck ? "مسار الديمو مفحوص" : "شغل Autopilot حتى يظهر قرار الوكيل",
        summary: demoWorkflowCheck?.summary ?? "الوكيل سيجمع بيانات الأرض، النباتات، الطقس، الخزان، والجهاز ثم يقرر هل يحضر أمر ري أو يوقف التنفيذ.",
        steps: [
          {
            label: "المدخلات",
            value: selectedLand ? selectedLand.name : "اختر أرض محفوظة",
            state: selectedLand ? "ready" : "missing"
          },
          {
            label: "فحص الديمو",
            value: demoWorkflowCheck ? `${Number(demoWorkflowCheck.score ?? 0).toFixed(0)}/100` : "غير مشغل",
            state: demoWorkflowCheck ? "ready" : "partial"
          },
          {
            label: "المانع الحالي",
            value: workflowBlocker?.title ?? "غير معروف بعد",
            state: workflowBlocker ? "missing" : "partial"
          }
        ]
      };
    }

    const hasBlockers = decision.blockers.length > 0;
    const hasWarnings = decision.warnings.length > 0;

    return {
      status: decision.decision,
      headline: hasBlockers
        ? "الوكيل أوقف التنفيذ لسبب واضح"
        : hasWarnings
          ? "الوكيل يحتاج موافقة تشغيل"
          : "الوكيل جاهز لتحضير أمر ري",
      summary: decision.reason,
      steps: [
        {
          label: "الأرض",
          value: `${decision.land_name} / auto ${decision.auto_enabled ? "ON" : "OFF"}`,
          state: decision.auto_enabled ? "ready" : "partial"
        },
        {
          label: "الماء المطلوب",
          value: decision.water
            ? `${Number(decision.water.liters_per_irrigation ?? 0).toFixed(1)} L كل ${Number(decision.water.interval_days ?? 1).toFixed(0)} يوم`
            : "لا توجد حسبة ري",
          state: decision.water ? "ready" : "missing"
        },
        {
          label: "الخزان",
          value: decision.water
            ? decision.water.tank_shortage_liters > 0
              ? `ناقص ${Number(decision.water.tank_shortage_liters).toFixed(1)} L`
              : `دفعة آمنة ${Number(decision.water.safe_batch_liters ?? 0).toFixed(1)} L`
            : "غير محسوب",
          state: decision.water?.tank_shortage_liters && decision.water.tank_shortage_liters > 0 ? "missing" : "ready"
        },
        {
          label: "الجهاز",
          value: decision.device ? decision.device.uid : "لا يوجد ESP32 فعال",
          state: decision.device ? "ready" : "missing"
        },
        {
          label: "الإجراء التالي",
          value: decision.next_action,
          state: hasBlockers ? "missing" : hasWarnings ? "partial" : "ready"
        }
      ]
    };
  }, [autopilotScan, demoWorkflowCheck, selectedLand]);

  function requireAdminAction(action = "هذه العملية") {
    if (isAdmin) return true;
    setError(`${action} من صلاحيات المدير فقط. المستخدم يستطيع عرض حالة أرضه بدون تشغيل أو تغيير.`);
    return false;
  }

  useEffect(() => {
    if (selectedLandId) {
      loadLandOps(selectedLandId);
      loadImpact(selectedLandId);
      setActionPlan(null);
      setUnifiedDecision(null);
      setIrrigationSchedule(null);
      setDeviceProvisioning(null);
      setHardwareReadiness(null);
      setWorkOrders(null);
      setSensorInsight(null);
      setWeatherRisk(null);
      setOperatorChecklist(null);
      setPestResponse(null);
      setAgentRun(null);
      setLandQuestionAnswer(null);
      setEvidenceReport(null);
    } else {
      setLandOps(null);
      setImpact(null);
      setActionPlan(null);
      setUnifiedDecision(null);
      setIrrigationSchedule(null);
      setDeviceProvisioning(null);
      setHardwareReadiness(null);
      setWorkOrders(null);
      setSensorInsight(null);
      setWeatherRisk(null);
      setOperatorChecklist(null);
      setPestResponse(null);
      setLandQuestionAnswer(null);
      setEvidenceReport(null);
    }
  }, [selectedLandId]);

  function updateMapCenter(center: [number, number]) {
    setLat(center[0].toFixed(6));
    setLon(center[1].toFixed(6));
  }

  async function loadPlace() {
    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) return;

    setPlaceLoading(true);
    try {
      const response = await fetch(`/api/geocode/reverse?lat=${parsedLat}&lon=${parsedLon}`);
      const payload = await response.json();
      if (response.ok) {
        setPlace(payload);
      }
    } finally {
      setPlaceLoading(false);
    }
  }

  function updatePolygon(points: [number, number][]) {
    setPolygonPoints(points);
    const geojson = polygonToGeojson(points);
    const area = calculatePolygonAreaM2(points);

    setLandGeojson(geojson);
    if (area > 0) {
      setAreaM2(area.toFixed(1));
    }
  }

  function applyLandFields(land: Land) {
    const landPolygon = geojsonToPolygon(land.boundary_geojson);
    setLandName(land.name);
    setCropHint(land.crop_hint ?? "");
    setAreaM2(String(Number(land.area_m2 ?? 0).toFixed(1)));
    setAutoIrrigationEnabled(Boolean(land.auto_irrigation_enabled));
    if (landPolygon.length) {
      setPolygonPoints(landPolygon);
      setLandGeojson(JSON.stringify(land.boundary_geojson));
      setLat(landPolygon[0][0].toFixed(6));
      setLon(landPolygon[0][1].toFixed(6));
    }
  }

  function useLand(land: Land) {
    setSelectedPottedPlantId("");
    setSelectedLandId(String(land.id));
    applyLandFields(land);
    setStatus(`تم اختيار ${land.name} للتحليل.`);
  }

  function isPottedTargetLand(land: Land | undefined, plant: PottedPlant) {
    const name = String(land?.name ?? "").trim().toLowerCase();
    const plantName = String(plant.name ?? "").trim().toLowerCase();
    return Boolean(
      name.startsWith("نبات:")
      || name.startsWith("plant:")
      || (plantName && name.includes(plantName) && name.includes("نبات"))
    );
  }

  async function repairPottedPlantTarget(plant: PottedPlant) {
    setStatus(`جاري تجهيز هدف مستقل للنبات ${plant.name} حتى لا يستخدم توصيات أرض أخرى...`);
    const response = await fetch(`/api/potted-plants/${plant.id}/ensure-target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: Number(lat),
        lon: Number(lon),
        owner_id: currentUser?.id,
        auto_irrigation_enabled: autoIrrigationEnabled
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تجهيز هدف مستقل للنبات.");
      setStatus("");
      return;
    }

    setSelectedPottedPlantId(String(payload.plant.id));
    setSelectedLandId(String(payload.land.id));
    applyLandFields(payload.land);
    await loadLands(currentUser?.id);
    await loadPottedPlants(currentUser?.id);
    await loadLandOps(String(payload.land.id));
    setStatus(`تم تجهيز هدف مستقل للنبات ${payload.plant.name}. اربط ESP32 بهذا النبات إذا تريد استخدام حساسات الرطوبة والماطور عليه.`);
  }

  function usePottedPlant(plant: PottedPlant) {
    setSelectedPottedPlantId(String(plant.id));
    setPottedPlantName(plant.name);
    setPottedPlantLocation(plant.location_label ?? "");
    setPottedPlantNotes(plant.notes ?? "");
    if (plant.flow_rate_liters_per_minute && Number(plant.flow_rate_liters_per_minute) > 0) {
      setFlowRate(String(plant.flow_rate_liters_per_minute));
    }
    if (plant.analysis_json && plant.command_preview) {
      setPottedPlantResult({
        analysis: plant.analysis_json,
        commandPreview: plant.command_preview,
        sensorContext: plant.sensor_context,
        saved: { pottedPlantId: plant.id, imagePath: plant.image_url, reusedImage: true }
      });
    }
    if (plant.linked_land_id) {
      const linkedLand = lands.find((land) => land.id === plant.linked_land_id);
      if (linkedLand && isPottedTargetLand(linkedLand, plant)) {
        applyLandFields(linkedLand);
        setSelectedLandId(String(plant.linked_land_id));
      } else if (linkedLand) {
        setSelectedLandId("");
        setLandOps(null);
        void repairPottedPlantTarget(plant);
      } else {
        setSelectedLandId(String(plant.linked_land_id));
      }
      setSelectedPottedPlantId(String(plant.id));
    } else {
      setSelectedLandId("");
      setLandOps(null);
    }
    setActiveSection("field");
    setStatus(`تم اختيار النبات ${plant.name}. يمكن إعادة تحليله من الصورة المحفوظة بدون رفع جديد.`);
  }

  function selectSavedLand(id: string) {
    setSelectedLandId(id);
    const land = lands.find((item) => String(item.id) === id);
    if (land) {
      useLand(land);
    }
  }

  function selectCropCatalogItem(id: string) {
    setSelectedCropCatalogId(id);
    const crop = cropCatalog.find((item) => item.id === id);
    if (!crop) return;

    setManualPlantName(crop.nameEn);
    setManualPlantNotes(
      `${crop.nameAr}: ${crop.litersPerUnitPerIrrigation} لتر لكل ${crop.unit === "m2" ? "م2" : "نبات/شجرة"} كل ${crop.intervalDays} يوم. نسبة السقاية ${crop.wateringPercent}%.`
    );
  }

  async function askAdvisor() {
    if (!requireAdminAction("استشارة AI التشغيلية")) return;
    setError("");
    setStatus("جاري توليد خطة AI للأرض والطقس...");
    setAdvisory(null);

    const response = await fetch("/api/advisor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        landId: selectedLandId || undefined,
        landName,
        cropHint,
        areaM2,
        lat,
        lon,
        place,
        hasImageAnalysis: Boolean(result),
        hasIotDevice: Boolean(deviceUid),
        savedLandsCount: lands.length
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "فشل مستشار الذكاء الاصطناعي.");
      setStatus("");
      return;
    }

    setAdvisory(payload);
    setStatus("تم توليد خطة AI قابلة للتنفيذ.");
  }

  async function analyze() {
    if (!requireAdminAction("تحليل الصور وحساب الري")) return;
    setError("");
    setStatus("جاري تحليل الصورة وجلب الطقس الحقيقي...");
    setResult(null);

    if (!image) {
      setError("اختار صورة حقيقية من الهاتف أو الدرون أولاً.");
      setStatus("");
      return;
    }

    const form = new FormData();
    form.set("image", image);
    form.set("lat", lat);
    form.set("lon", lon);
    form.set("areaM2", areaM2);
    form.set("cropHint", cropHint);
    if (selectedLandId) form.set("landId", selectedLandId);
    form.set("flowRateLitersPerMinute", flowRate);
    form.set("tankAvailableLiters", tankCurrentLiters);
    form.set("tankDailyRefillLiters", tankDailyRefillLiters);
    form.set("tankReserveLiters", tankReserveLiters);
    form.set("waterSavingPercent", waterSavingPercent);
    form.set("irrigationMode", irrigationMode);

    const response = await fetch("/api/analyze", {
      method: "POST",
      body: form
    });

    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "فشل التحليل.");
      setStatus("");
      return;
    }

    setResult(payload);
    await loadDashboard();
    if (selectedLandId) await loadLandOps(selectedLandId);
    if (selectedLandId) await loadImpact(selectedLandId);
    setStatus(
      payload.saved?.duplicateImage
        ? `اكتمل التحليل. الصورة مكررة، لم نحفظ نسخة ثانية، وربطنا التحليل بالصورة رقم ${payload.saved.imageryId}.`
        : payload.saved?.imageryId
        ? `اكتمل التحليل وتم حفظ الصورة كدليل رقم ${payload.saved.imageryId}.`
        : "اكتمل التحليل الحقيقي. اختر أرضاً محفوظة حتى يتم أرشفة الصورة وربطها بالسجل."
    );
  }

  async function analyzePottedPlantOnly() {
    if (!requireAdminAction("تحليل نبات من صورة فقط")) return;
    setError("");
    setStatus("جاري تحليل النبات من الصورة فقط بدون خريطة أو أرض...");
    setPottedPlantResult(null);

    if (!image) {
      setError("اختار صورة واضحة للنبات أو الأصيص أولاً.");
      setStatus("");
      return;
    }

    const form = new FormData();
    form.set("image", image);
    form.set("flowRateLitersPerMinute", flowRate);
    if (selectedLandId) form.set("landId", selectedLandId);
    if (currentUser?.id) form.set("ownerId", currentUser.id);
    form.set("savePlant", "true");
    form.set("plantName", pottedPlantName);
    form.set("locationLabel", pottedPlantLocation);
    form.set("notes", pottedPlantNotes);

    const response = await fetch("/api/potted-plant/analyze", {
      method: "POST",
      body: form
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تحليل النبات من الصورة.");
      setStatus("");
      return;
    }

    setPottedPlantResult(payload);
    if (payload.saved?.pottedPlantId) {
      setSelectedPottedPlantId(String(payload.saved.pottedPlantId));
    }
    await loadPottedPlants(currentUser?.id);
    setStatus(payload.saved?.pottedPlantId
      ? "تم تحليل النبات وحفظه. تقدر ترجع له من صفحة الأراضي والنباتات بدون رفع الصورة مرة ثانية."
      : "تم تحليل النبات/الأصيص من الصورة فقط. راجع كمية الري المقترحة قبل الإرسال.");
  }

  function applyPottedPlantIrrigation() {
    if (!pottedPlantResult) return;
    const liters = Number(pottedPlantResult.commandPreview.liters_target ?? 0);
    const durationSeconds = Number(pottedPlantResult.commandPreview.duration_seconds ?? 0);
    if (liters > 0) setManualIrrigationLitersTarget(String(Number(liters.toFixed(3))));
    if (durationSeconds > 0) setManualIrrigationDurationSeconds(String(durationSeconds));
    if (pottedPlantResult.commandPreview.flow_rate_liters_per_minute > 0) {
      setFlowRate(String(pottedPlantResult.commandPreview.flow_rate_liters_per_minute));
    }
    setStatus("تم نقل توصية النبات إلى الري اليدوي. اختر ESP32 ثم أرسل الأمر إذا كان الأنبوب فعلاً على هذا النبات.");
  }

  async function analyzeSavedImagery() {
    if (!requireAdminAction("تحليل الصور المحفوظة للأرض")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري تحليل الصور المحفوظة للأرض وتجميع النتائج...");
    const response = await fetch(`/api/lands/${selectedLandId}/reanalyze-imagery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat,
        lon,
        flowRateLitersPerMinute: Number(flowRate),
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تحليل الصور المحفوظة.");
      setStatus("");
      return;
    }

    await loadLandOps(selectedLandId);
    await loadDashboard();
    await loadImpact(selectedLandId);
    setStatus(
      `تم تحليل ${payload.analyzed} صور محفوظة، وتخطي ${payload.skippedExisting} محللة سابقاً، وتجاهل ${payload.skippedDuplicates} مكررة.`
    );
  }

  async function generatePhotoMissionPlan() {
    if (!requireAdminAction("توليد خطة التصوير")) return;
    setError("");
    setStatus("جاري توليد خطة تصوير AI للهاتف أو الدرون...");
    setPhotoMission(null);

    const response = await fetch("/api/photo-mission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        landId: selectedLandId || undefined,
        landName,
        cropHint,
        areaM2,
        lat,
        lon,
        place,
        hasRecentImageAnalysis: Boolean(result),
        hasIotDevice: Boolean(deviceUid)
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد خطة التصوير.");
      setStatus("");
      return;
    }

    setPhotoMission(payload);
    setStatus("تم توليد خطة تصوير قبل التحليل.");
  }

  async function sendIotCommand(recommendation?: {
    id?: number;
    recommended_duration_seconds: number;
    total_liters_per_day?: number;
  }) {
    if (!requireAdminAction("إرسال أمر الري إلى IoT")) return;
    const latestSystemRecommendation = recommendation
      ?? landOps?.recent.recommendations?.[0]
      ?? (result?.saved?.recommendationId
        ? {
            id: result.saved.recommendationId,
            recommended_duration_seconds: result.irrigation.recommendedIrrigationDurationSeconds ?? result.irrigation.recommendedDurationSeconds
          }
        : null);
    if (!result && !latestSystemRecommendation) {
      setError("لا توجد توصية ري محفوظة من النظام. شغل تحليل صورة أو تحليل الصور المحفوظة أولاً حتى ينشئ النظام توصية صالحة.");
      return;
    }
    setError("");
    if (selectedLandId && !esp32Online) {
      setError(esp32ConnectionMessage);
      setStatus("");
      return;
    }
    setStatus("جاري تسجيل أمر الري وإرساله عبر MQTT...");
    const targetDeviceUid = deviceUid.trim() || landOps?.recent.devices.find((device) => device.is_active)?.device_uid || "";

    if (!targetDeviceUid) {
      setError("لا يوجد Device UID. اكتب معرف ESP32 أو اربط جهازاً محفوظاً بهذه الأرض أولاً.");
      setStatus("");
      return;
    }

    const litersTarget = Number(latestSystemRecommendation?.total_liters_per_day ?? result?.irrigation.totalLitersPerDay);
    const flowRateLpm = Math.max(0.1, Number(flowRate) || 10);
    const requestedDurationSeconds = Number.isFinite(litersTarget) && litersTarget > 0
      ? Math.ceil((litersTarget / flowRateLpm) * 60)
      : Number(latestSystemRecommendation?.recommended_duration_seconds ?? result?.irrigation.recommendedIrrigationDurationSeconds ?? result?.irrigation.recommendedDurationSeconds);
    if (!Number.isFinite(requestedDurationSeconds) || requestedDurationSeconds <= 0 || requestedDurationSeconds > 86400) {
      setError("مدة توصية الري يجب أن تكون بين 1 و 86400 ثانية. المنصة ستقسم أي مدة فوق 1800 ثانية إلى دفعات آمنة.");
      setStatus("");
      return;
    }

    const response = await fetch("/api/iot/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: selectedLandId ? Number(selectedLandId) : 1,
        device_uid: targetDeviceUid,
        recommendation_id: latestSystemRecommendation?.id || result?.saved?.recommendationId,
        duration_seconds: requestedDurationSeconds,
        liters_target: Number.isFinite(litersTarget) && litersTarget > 0 ? litersTarget : null,
        flow_rate_liters_per_minute: flowRateLpm,
        recalculate_duration_from_flow: true,
        reason: "Full system irrigation recommendation"
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      if (selectedLandId) await loadLandOps(selectedLandId);
      setError(
        payload.commandId
          ? `فشل إرسال MQTT وتم حفظ سجل الأمر رقم ${payload.commandId}: ${payload.error}`
          : payload.error ?? "فشل إرسال MQTT."
      );
      setStatus("");
      return;
    }

    if (selectedLandId) await loadLandOps(selectedLandId);
    if (selectedLandId) await loadImpact(selectedLandId);
    setStatus(payload.durationWasSplit
      ? `تم نشر أول دفعة ري آمنة رقم ${payload.commandId}: ${payload.publishedDurationSeconds}s / ${Number(payload.publishedLitersTarget ?? 0).toFixed(1)}L من أصل ${payload.requestedDurationSeconds}s حسب تدفق ${flowRateLpm.toFixed(1)} L/min.`
      : `تم نشر أمر الري رقم ${payload.commandId} إلى ${payload.topic} حسب تدفق ${flowRateLpm.toFixed(1)} L/min`);
  }

  async function sendManualIrrigationOverride() {
    if (!requireAdminAction("إرسال ري يدوي مباشر")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة قبل إرسال أمر ري يدوي.");
      return;
    }
    if (!esp32Online) {
      setError(esp32ConnectionMessage);
      setStatus("");
      return;
    }

    const targetDeviceUid = deviceUid.trim() || landOps?.recent.devices.find((device) => device.is_active)?.device_uid || "";
    if (!targetDeviceUid) {
      setError("لا يوجد ESP32 فعال لهذه الأرض. اربط الجهاز أو اكتب Device UID أولاً.");
      return;
    }

    const durationSeconds = Number(manualIrrigationDurationSeconds);
    const litersTarget = Number(manualIrrigationLitersTarget);
    const flowRateLpm = Math.max(0.1, Number(flowRate) || 10);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) {
      setError("مدة الري اليدوي يجب أن تكون بين 1 و 86400 ثانية. إذا تجاوزت 1800 ثانية سترسل المنصة أول دفعة آمنة فقط.");
      return;
    }

    setError("");
    setStatus("جاري إرسال أمر ري يدوي مباشر بصلاحية المدير عبر MQTT...");
    const response = await fetch("/api/iot/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: Number(selectedLandId),
        device_uid: targetDeviceUid,
        duration_seconds: durationSeconds,
        liters_target: Number.isFinite(litersTarget) && litersTarget > 0 ? litersTarget : null,
        flow_rate_liters_per_minute: flowRateLpm,
        manual_override: true,
        reason: "Admin manual irrigation override"
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      if (selectedLandId) await loadLandOps(selectedLandId);
      setError(payload.error ?? "فشل إرسال أمر الري اليدوي.");
      setStatus("");
      return;
    }

    if (selectedLandId) await loadLandOps(selectedLandId);
    if (selectedLandId) await loadImpact(selectedLandId);
    setStatus(payload.durationWasSplit
      ? `تم نشر أول دفعة يدوية آمنة رقم ${payload.commandId}: ${payload.publishedDurationSeconds}s حسب تدفق ${flowRateLpm.toFixed(1)} L/min.`
      : `تم نشر أمر ري يدوي مباشر رقم ${payload.commandId} إلى ${payload.topic} حسب تدفق ${flowRateLpm.toFixed(1)} L/min`);
  }

  async function sendEmergencyStopCommand() {
    if (!requireAdminAction("إيقاف الري فوراً")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة قبل إرسال أمر إيقاف.");
      setStatus("");
      return;
    }

    const targetDeviceUid = deviceUid.trim() || landOps?.recent.devices.find((device) => device.is_active)?.device_uid || "";
    if (!targetDeviceUid) {
      setError("لا يوجد ESP32 فعال لهذه الأرض. اربط الجهاز أو اكتب Device UID أولاً.");
      setStatus("");
      return;
    }

    setError("");
    setStatus("جاري إرسال أمر إيقاف فوري للصمام عبر MQTT...");
    const response = await fetch("/api/iot/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: Number(selectedLandId),
        device_uid: targetDeviceUid,
        status: "OFF",
        duration_seconds: 0,
        liters_target: 0,
        flow_rate_liters_per_minute: Math.max(0.1, Number(flowRate) || 10),
        manual_override: true,
        reason: "Admin emergency stop irrigation command"
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      if (selectedLandId) await loadLandOps(selectedLandId);
      setError(payload.error ?? "فشل إرسال أمر الإيقاف.");
      setStatus("");
      return;
    }

    if (selectedLandId) await loadLandOps(selectedLandId);
    if (selectedLandId) await loadImpact(selectedLandId);
    setStatus(`تم نشر أمر إيقاف فوري رقم ${payload.commandId}. راقب ACK حتى تتأكد أن ESP32 أغلق الصمام.`);
  }

  async function runRelayDiagnosticTest() {
    if (!requireAdminAction("اختبار Relay")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة حتى نعرف الجهاز المرتبط بها.");
      return;
    }

    const activeDevice = landOps?.recent.devices.find((device) => device.is_active)?.device_uid || deviceUid || "esp32-land-2-demo-valve";
    setError("");
    setStatus(`جاري إرسال اختبار Relay لمدة 5 ثواني إلى ${activeDevice}...`);

    const response = await fetch("/api/iot/relay-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: Number(selectedLandId),
        device_uid: activeDevice,
        duration_seconds: 5
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل اختبار Relay.");
      setStatus("");
      if (selectedLandId) await loadLandOps(selectedLandId);
      return;
    }

    if (selectedLandId) await loadLandOps(selectedLandId);
    if (payload.ack?.received) {
      setStatus(`وصل ACK لاختبار Relay رقم ${payload.commandId}. الحالة: ${payload.ack.payload?.status ?? payload.ack.status ?? "acknowledged"}.`);
    } else {
      setStatus(`تم نشر اختبار Relay رقم ${payload.commandId} لكن لم يصل ACK خلال 10 ثواني. افحص Serial Monitor والـ MQTT topic: ${(payload.topics ?? []).join(" / ")}`);
    }
  }

  async function sendIrrigationScheduleSlot(slot: IrrigationScheduleResult["schedule"]["slots"][number]) {
    if (!irrigationSchedule) return;

    if (!slot.send_mqtt || Number(slot.duration_seconds ?? 0) <= 0) {
      setError("هذا الـ slot غير مهيأ للإرسال عبر MQTT. راجع سبب الجدولة وفحوص السلامة أولاً.");
      return;
    }

    await sendIotCommand({
      id: irrigationSchedule.schedule.water_budget.source_recommendation_id || undefined,
      recommended_duration_seconds: Number(slot.duration_seconds)
    });
  }

  async function approveAgentCommand() {
    if (!requireAdminAction("اعتماد أمر Agent")) return;
    if (!agentRun) return;

    const command = agentRun.agent.proposed_command;
    const payload = command.payload;
    const durationSeconds = Number(payload.duration_seconds ?? 0);

    if (!command.allowed_to_prepare || payload.status !== "ON") {
      setError("Agent لم يجهز أمر تشغيل مسموح. راجع فحوص الأمان والبيانات الناقصة.");
      return;
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1800) {
      setError("مدة أمر Agent خارج حدود الأمان 1..1800 ثانية. قسم الرية أو خفّض الكمية قبل الإرسال.");
      return;
    }

    if (!payload.device_uid) {
      setError("أمر Agent لا يحتوي Device UID فعال.");
      return;
    }

    setError("");
    setStatus("جاري اعتماد أمر Agent وإرساله عبر مسار الأمان...");

    const response = await fetch("/api/iot/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: payload.land_id || Number(selectedLandId),
        device_uid: payload.device_uid,
        recommendation_id: landOps?.recent.recommendations?.[0]?.id,
        duration_seconds: durationSeconds
      })
    });
    const resultPayload = await response.json();

    if (!response.ok) {
      if (selectedLandId) await loadLandOps(selectedLandId);
      setError(
        resultPayload.commandId
          ? `تم حفظ أمر Agent لكن أوقفه مسار الأمان رقم ${resultPayload.commandId}: ${resultPayload.error}`
          : resultPayload.error ?? "فشل إرسال أمر Agent."
      );
      setStatus("");
      return;
    }

    if (selectedLandId) await loadLandOps(selectedLandId);
    if (selectedLandId) await loadImpact(selectedLandId);
    setStatus(`تم اعتماد أمر Agent ونشره إلى ${resultPayload.topic}`);
  }

  async function approveAutopilotDecision(
    decision: AutopilotScanResult["decisions"][number],
    batch?: NonNullable<NonNullable<AutopilotScanResult["decisions"][number]["water"]>["batch_plan"]>[number]
  ) {
    if (!requireAdminAction("اعتماد قرار Autopilot")) return;

    const durationSeconds = Number(batch?.duration_seconds ?? decision.water?.duration_seconds ?? 0);
    const litersTarget = Number(batch?.liters_target ?? decision.water?.safe_batch_liters ?? 0);
    const deviceUid = decision.device?.uid ?? "";

    if (decision.decision !== "prepare_irrigation") {
      setError("قرار Autopilot ليس جاهزاً للتشغيل التلقائي. راجع السبب والخطوة التالية.");
      return;
    }

    if (!deviceUid) {
      setError("قرار Autopilot لا يحتوي جهاز ESP32 فعال.");
      return;
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1800) {
      setError("مدة قرار Autopilot خارج حدود الأمان 1..1800 ثانية.");
      return;
    }

    setError("");
    setStatus(`جاري اعتماد قرار Autopilot لأرض ${decision.land_name}...`);

    const response = await fetch("/api/iot/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: decision.land_id,
        device_uid: deviceUid,
        duration_seconds: durationSeconds,
        liters_target: litersTarget,
        batch: batch?.batch,
        batch_total: decision.water?.batch_plan?.length,
        reason: batch
          ? `Autopilot batch ${batch.batch}/${decision.water?.batch_plan?.length ?? "?"} for ${decision.land_name}`
          : `Autopilot decision for ${decision.land_name}`
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      await loadLandOps(String(decision.land_id));
      setError(
        payload.commandId
          ? `تم حفظ أمر Autopilot لكن أوقفه مسار الأمان رقم ${payload.commandId}: ${payload.error}`
          : payload.error ?? "فشل إرسال قرار Autopilot."
      );
      setStatus("");
      return;
    }

    await loadDashboard();
    await loadLandOps(String(decision.land_id));
    await loadImpact(String(decision.land_id));
    setStatus(`تم اعتماد Autopilot ونشر أمر ${decision.land_name} إلى ${payload.topic}`);
  }

  async function registerEsp32Device() {
    if (!requireAdminAction("تجهيز وربط ESP32")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً حتى يتم ربط ESP32 بها.");
      return;
    }

    setError("");
    setStatus("جاري تسجيل وتجهيز ESP32 لهذه الأرض...");
    setDeviceProvisioning(null);

    const response = await fetch(`/api/lands/${selectedLandId}/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_uid: deviceUid || undefined,
        relay_pin: 26
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تسجيل جهاز ESP32.");
      setStatus("");
      return;
    }

    setDeviceProvisioning(payload);
    setDeviceUid(payload.device.device_uid);
    await loadIotDevices();
    await loadLandOps(selectedLandId);
    setStatus(`تم تجهيز ESP32 وربطه بالأرض: ${payload.device.device_uid}`);
  }

  async function createAdminEspDevice() {
    if (!requireAdminAction("إضافة ESP32 من لوحة Admin")) return;
    const landId = adminEspLandId || selectedLandId || lands[0]?.id;
    if (!landId) {
      setError("اختر أرضاً أولية للجهاز. قاعدة البيانات الحالية تحتاج land_id لكل ESP32.");
      return;
    }

    setError("");
    setStatus("جاري إضافة/تحديث ESP32 وملحقاته...");
    setDeviceProvisioning(null);

    const response = await fetch("/api/iot/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: Number(landId),
        device_uid: adminEspDeviceUid || undefined,
        relay_pin: Number(adminEspRelayPin),
        pump_flow_liters_per_minute: Number(adminEspPumpFlow),
        soil_sensor_model: adminEspSoilSensorModel,
        tank_sensor_model: adminEspTankSensorModel,
        relay_model: adminEspRelayModel,
        pump_model: adminEspPumpModel,
        notes: adminEspNotes,
        has_soil_moisture_sensor: adminEspHasSoilSensor,
        has_tank_level_sensor: adminEspHasTankSensor,
        has_relay: adminEspHasRelay,
        has_pump: adminEspHasPump,
        has_flow_meter: adminEspHasFlowMeter
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل إضافة ESP32.");
      setStatus("");
      return;
    }

    setDeviceProvisioning(payload);
    setDeviceUid(payload.device.device_uid);
    setAdminEspDeviceUid(payload.device.device_uid);
    setAdminEspBindLandId(String(payload.device.land_id));
    if (payload.accessories?.pump_flow_liters_per_minute) {
      setFlowRate(String(payload.accessories.pump_flow_liters_per_minute));
    }
    await loadIotDevices();
    await loadDashboard();
    if (selectedLandId) await loadLandOps(selectedLandId);
    setStatus(
      payload.accessoriesPersisted
        ? `تم حفظ ESP32 وملحقاته: ${payload.device.device_uid}`
        : `تم حفظ ESP32 الأساسي: ${payload.device.device_uid}. لحفظ الملحقات دائماً شغّل outputs/iot_device_accessories_schema.sql في Supabase.`
    );
  }

  async function bindAdminEspDevice() {
    if (!requireAdminAction("ربط ESP32 بأرض")) return;
    const targetDeviceUid = adminEspDeviceUid || deviceUid;
    if (!targetDeviceUid || !adminEspBindLandId) {
      setError("اختر ESP32 واختر الأرض التي تريد ربطها بها.");
      return;
    }

    setError("");
    setStatus(`جاري ربط ${targetDeviceUid} بالأرض المختارة...`);
    const response = await fetch("/api/iot/devices/bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: Number(adminEspBindLandId),
        device_uid: targetDeviceUid
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل ربط ESP32 بالأرض.");
      setStatus("");
      return;
    }

    setSelectedLandId(String(payload.land.id));
    setDeviceUid(targetDeviceUid);
    await loadIotDevices();
    await loadLandOps(String(payload.land.id));
    await loadDashboard();
    setStatus(`تم ربط ${targetDeviceUid} بـ ${payload.land.name}.`);
  }

  async function copyFirmwareConfig() {
    if (!deviceProvisioning) return;
    await navigator.clipboard.writeText(deviceProvisioning.firmwareConfig);
    setStatus("تم نسخ إعدادات firmware للجهاز.");
  }

  async function loadCurrentProfile(userId: string) {
    const response = await fetch(`/api/me?userId=${encodeURIComponent(userId)}`);
    const payload = await response.json();
    if (response.ok) {
      setCurrentProfile(payload.profile ?? null);
      return;
    }
    setError(payload.error ?? "Failed to load user profile.");
  }

  async function signIn() {
    setError("");
    setStatus("جاري تسجيل الدخول...");
    const { data, error: authError } = await supabaseClient.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword
    });

    if (authError) {
      setError(authError.message);
      setStatus("");
      return;
    }

    setCurrentUser(data.user);
    if (data.user) await loadCurrentProfile(data.user.id);
    setStatus("تم تسجيل الدخول.");
  }

  async function signOut() {
    await supabaseClient.auth.signOut();
    setCurrentUser(null);
    setCurrentProfile(null);
    setLands([]);
    setDeletedLands([]);
    setPottedPlants([]);
    setAdminUsers([]);
    setActiveSection("assets");
    setWorkspaceMode("user");
    setStatus("تم تسجيل الخروج.");
  }

  async function loadAdminUsers() {
    if (!currentUser) return;
    const response = await fetch(`/api/admin/users?requesterId=${encodeURIComponent(currentUser.id)}`);
    const payload = await response.json();
    if (response.ok) {
      setAdminUsers(payload.users ?? []);
    } else {
      setError(payload.error ?? "Failed to load admin users.");
    }
  }

  async function createManagedUser() {
    if (!requireAdminAction("إضافة المستخدمين")) return;
    if (!currentUser) return;
    setError("");
    setStatus("جاري إنشاء المستخدم في Supabase Auth...");
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requester_id: currentUser.id,
        email: newUserEmail,
        password: newUserPassword,
        full_name: newUserName,
        role: newUserRole
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "Failed to create user.");
      setStatus("");
      return;
    }

    setNewUserEmail("");
    setNewUserPassword("");
    setNewUserName("");
    await loadAdminUsers();
    setStatus("تم إنشاء المستخدم وربطه بنظام الدخول الحقيقي.");
  }

  async function assignLandToUser() {
    if (!requireAdminAction("ربط المستخدم بالأرض")) return;
    if (!currentUser || !selectedAdminUserId || !selectedAdminLandId) return;
    setError("");
    setStatus("جاري ربط المستخدم بالأرض...");
    const response = await fetch("/api/admin/land-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requester_id: currentUser.id,
        profile_id: selectedAdminUserId,
        land_id: Number(selectedAdminLandId),
        role: "farmer"
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "Failed to link user with land.");
      setStatus("");
      return;
    }

    await loadAdminUsers();
    await loadLands(currentUser.id);
    setStatus("تم ربط المستخدم بالأرض. المستخدم لن يرى إلا أرضه عند الدخول.");
  }

  async function deleteManagedUser(userId: string) {
    if (!requireAdminAction("حذف المستخدمين")) return;
    if (!currentUser) return;
    if (userId === currentUser.id) {
      setError("لا يمكن حذف الحساب الحالي من نفس الجلسة.");
      return;
    }
    if (!window.confirm("هل تريد حذف هذا المستخدم نهائياً من Supabase Auth؟")) return;

    setError("");
    setStatus("جاري حذف المستخدم...");
    const response = await fetch(
      `/api/admin/users?requesterId=${encodeURIComponent(currentUser.id)}&userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "Failed to delete user.");
      setStatus("");
      return;
    }

    await loadAdminUsers();
    await loadLands(currentUser.id);
    setStatus("تم حذف المستخدم وكل صلاحياته.");
  }

  async function unlinkLandAccess(membershipId: number) {
    if (!requireAdminAction("فك ربط الأراضي")) return;
    if (!currentUser) return;
    if (!window.confirm("هل تريد فك ربط هذه الأرض عن المستخدم؟")) return;

    setError("");
    setStatus("جاري فك الربط...");
    const response = await fetch(
      `/api/admin/land-access?requesterId=${encodeURIComponent(currentUser.id)}&membershipId=${membershipId}`,
      { method: "DELETE" }
    );
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "Failed to unlink land.");
      setStatus("");
      return;
    }

    await loadAdminUsers();
    await loadLands(currentUser.id);
    setStatus("تم فك ربط الأرض عن المستخدم.");
  }

  async function deleteLand(landId: number) {
    if (!requireAdminAction("حذف الأراضي")) return;
    if (!currentUser) return;
    if (!window.confirm("سيتم نقل الأرض إلى المحذوفات فقط، ولن يتم حذف قطعة ESP32 أو سجلاتها. هل تريد المتابعة؟")) return;

    setError("");
    setStatus("جاري نقل الأرض إلى المحذوفات...");
    const response = await fetch(
      `/api/lands?id=${landId}&requesterId=${encodeURIComponent(currentUser.id)}`,
      { method: "DELETE" }
    );
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل حذف الأرض.");
      setStatus("");
      return;
    }

    if (selectedLandId === String(landId)) {
      setSelectedLandId("");
      setLandOps(null);
      setImpact(null);
      setResult(null);
      setPolygonPoints([]);
      setLandGeojson("");
    }
    await loadLands(currentUser.id);
    await loadDeletedLands(currentUser.id);
    await loadIotDevices();
    await loadDashboard();
    setStatus("تم نقل الأرض إلى المحذوفات مع الحفاظ على ESP32 والسجلات.");
  }

  async function loadLands(userId = currentUser?.id) {
    const url = userId ? `/api/lands?userId=${encodeURIComponent(userId)}` : "/api/lands";
    const response = await fetch(url);
    const payload = await response.json();
    if (response.ok) {
      setLands(payload.lands ?? []);
    }
  }

  async function loadDeletedLands(userId = currentUser?.id) {
    const url = userId ? `/api/lands?deleted=1&userId=${encodeURIComponent(userId)}` : "/api/lands?deleted=1";
    const response = await fetch(url);
    const payload = await response.json();
    if (response.ok) {
      setDeletedLands(payload.lands ?? []);
      return;
    }
    setError(payload.error ?? "فشل تحميل محذوفات الأراضي.");
  }

  async function restoreLand(landId: number) {
    if (!requireAdminAction("استرجاع الأراضي")) return;
    if (!currentUser) return;

    setError("");
    setStatus("جاري استرجاع الأرض...");
    const response = await fetch("/api/lands", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: landId,
        action: "restore",
        requester_id: currentUser.id
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل استرجاع الأرض.");
      setStatus("");
      return;
    }

    await loadLands(currentUser.id);
    await loadDeletedLands(currentUser.id);
    await loadIotDevices();
    await loadDashboard();
    setStatus("تم استرجاع الأرض. يمكنك ربط ESP32 عليها مجدداً أو اختيارها مباشرة.");
  }

  async function loadPottedPlants(userId = currentUser?.id) {
    const url = userId ? `/api/potted-plants?userId=${encodeURIComponent(userId)}` : "/api/potted-plants";
    const response = await fetch(url);
    const payload = await response.json();
    if (response.ok) {
      setPottedPlants(payload.plants ?? []);
      return;
    }
    setError(payload.error ?? "فشل تحميل النباتات الفردية المحفوظة.");
  }

  async function reanalyzeSavedPottedPlant(plantId = selectedPottedPlantId) {
    if (!requireAdminAction("إعادة تحليل النبات المحفوظ")) return;
    if (!plantId) {
      setError("اختر نباتاً محفوظاً أولاً.");
      return;
    }

    setError("");
    setStatus("جاري إعادة تحليل النبات من الصورة المحفوظة وقراءة حساس ESP32 فقط...");
    const response = await fetch(`/api/potted-plants/${plantId}/reanalyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowRateLitersPerMinute: Number(flowRate)
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل إعادة تحليل النبات المحفوظ.");
      setStatus("");
      return;
    }

    setPottedPlantResult(payload);
    await loadPottedPlants(currentUser?.id);
    const linkedLandId = Number(payload.plant?.linked_land_id);
    if (Number.isFinite(linkedLandId) && linkedLandId > 0) {
      setSelectedLandId(String(linkedLandId));
      await loadLandOps(String(linkedLandId));
    }
    setStatus("تم تحديث تحليل النبات من الصورة المحفوظة. لم يتم استخدام رطوبة Open-Meteo للنباتات الفردية.");
  }

  async function deletePottedPlant(plantId: number) {
    if (!requireAdminAction("حذف النبات الفردي")) return;
    if (!currentUser) return;
    if (!window.confirm("هل تريد حذف هذا النبات الفردي من القائمة؟")) return;

    setError("");
    setStatus("جاري حذف النبات الفردي...");
    const response = await fetch(
      `/api/potted-plants?id=${plantId}&requesterId=${encodeURIComponent(currentUser.id)}`,
      { method: "DELETE" }
    );
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل حذف النبات الفردي.");
      setStatus("");
      return;
    }

    if (selectedPottedPlantId === String(plantId)) {
      setSelectedPottedPlantId("");
      setPottedPlantResult(null);
    }
    await loadPottedPlants(currentUser.id);
    setStatus("تم حذف النبات الفردي.");
  }

  async function loadDashboard() {
    const response = await fetch("/api/dashboard");
    const payload = await response.json();
    if (response.ok) {
      setDashboard(payload);
    }
  }

  async function loadIotDevices() {
    const response = await fetch("/api/iot/devices");
    const payload = await response.json();
    if (response.ok) {
      setIotDeviceInventory(payload);
      if (!deviceUid && payload.devices?.length) {
        const onlineDevice = payload.devices.find((device: IotDeviceInventoryResult["devices"][number]) => device.connection_status === "online");
        setDeviceUid((onlineDevice ?? payload.devices[0]).device_uid);
      }
      return;
    }
    setError(payload.error ?? "فشل تحميل أجهزة ESP32.");
  }

  async function useIotDevice(device: IotDeviceInventoryResult["devices"][number]) {
    setDeviceUid(device.device_uid);
    if (device.latestTelemetry?.flow_liters_per_minute && Number(device.latestTelemetry.flow_liters_per_minute) > 0) {
      setFlowRate(String(device.latestTelemetry.flow_liters_per_minute));
    }

    if (selectedPottedPlantId) {
      setError("");
      setStatus(`جاري ربط النبات الفردي بالقطعة ${device.device_uid}...`);
      const response = await fetch(`/api/potted-plants/${selectedPottedPlantId}/bind-device`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_uid: device.device_uid,
          lat: Number(lat),
          lon: Number(lon),
          owner_id: currentUser?.id
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "فشل ربط النبات الفردي بالـ ESP32.");
        setStatus("");
        return;
      }

      setSelectedPottedPlantId(String(payload.plant.id));
      setSelectedLandId(String(payload.land.id));
      if (payload.land) {
        applyLandFields(payload.land);
      }
      await loadPottedPlants(currentUser?.id);
      await loadIotDevices();
      await loadLandOps(String(payload.land.id));
      setStatus(`تم ربط النبات ${payload.plant.name} بالقطعة ${device.device_uid}. الحساسات والأوامر ستستخدم الهدف ${payload.land.name}.`);
      return;
    }

    if (selectedLandId) {
      setError("");
      setStatus(`جاري ربط ${device.device_uid} بالأرض/النبات الحالي...`);
      const response = await fetch("/api/iot/devices/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          land_id: Number(selectedLandId),
          device_uid: device.device_uid
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "فشل ربط ESP32 بالأرض الحالية.");
        setStatus("");
        return;
      }

      await loadIotDevices();
      await loadLandOps(selectedLandId);
      setStatus(
        `تم ربط ${device.device_uid} مباشرة بـ ${payload.land.name}. بقيت MQTT topics كما هي حتى لا تحتاج رفع firmware جديد للعرض.`
      );
      return;
    }

    setStatus(
      `تم اختيار ${device.device_uid}. اختر/احفظ نبات أو أرض إذا تريد ربطه وإرسال أمر ري محفوظ.`
    );
  }

  async function runSetupDoctor() {
    if (!requireAdminAction("فحص الإعدادات")) return;
    setError("");
    setStatus("جاري فحص إعدادات المنصة والجداول...");
    const response = await fetch("/api/setup/doctor");
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل فحص الإعداد.");
      setStatus("");
      return;
    }

    setSetupDoctor(payload);
    setStatus(`اكتمل فحص الإعداد: ${payload.score}/100.`);
  }

  async function loadLandOps(id = selectedLandId) {
    if (!id) return;
    const response = await fetch(`/api/lands/${id}/ops`);
    const payload = await response.json();
    if (response.ok) {
      setLandOps(payload);
    }
  }

  async function syncTankFromEsp32() {
    if (!requireAdminAction("سحب قراءة الخزان من ESP32")) return;

    setError("");
    setStatus("جاري البحث عن آخر قراءة خزان محفوظة من ESP32...");
    const params = new URLSearchParams();
    if (selectedLandId) params.set("landId", selectedLandId);
    params.set("tankCapacityLiters", tankCapacityLiters);

    const response = await fetch(`/api/tank/latest?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "لا توجد قراءة خزان محفوظة من ESP32 بعد.");
      setStatus("");
      return;
    }

    const tank = payload.tank ?? {};
    if (Number.isFinite(Number(tank.capacity_liters))) {
      setTankCapacityLiters(String(Number(tank.capacity_liters).toFixed(0)));
    }
    if (Number.isFinite(Number(tank.available_liters))) {
      setTankCurrentLiters(String(Number(tank.available_liters).toFixed(1)));
    }

    const source = `${tank.device_uid ?? "ESP32"}${tank.level_percent !== null && tank.level_percent !== undefined ? ` / ${Number(tank.level_percent).toFixed(0)}%` : ""}`;
    setTankSyncSource(source);
    setStatus(`تم تحديث الخزان من قراءة ${source}.`);
  }

  async function addManualPlant() {
    if (!requireAdminAction("إضافة النباتات يدوياً")) return;
    if (!currentUser || !selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري حفظ النبات اليدوي...");
    const response = await fetch(`/api/lands/${selectedLandId}/plants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requester_id: currentUser.id,
        name: manualPlantName,
        count: Number(manualPlantCount),
        growth_stage: manualPlantStage,
        notes: manualPlantNotes
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل حفظ النبات اليدوي.");
      setStatus("");
      return;
    }

    setManualPlantNotes("");
    await loadLandOps(selectedLandId);
    setStatus("تم حفظ النبات اليدوي، وسيعتمد عليه النظام كمصدر موثوق.");
  }

  async function deleteManualPlant(plantId: number) {
    if (!requireAdminAction("حذف النباتات اليدوية")) return;
    if (!currentUser || !selectedLandId) return;
    if (!window.confirm("هل تريد حذف هذا النبات من الجرد اليدوي؟")) return;

    setError("");
    setStatus("جاري حذف النبات اليدوي...");
    const response = await fetch(
      `/api/lands/${selectedLandId}/plants?requesterId=${encodeURIComponent(currentUser.id)}&plantId=${plantId}`,
      { method: "DELETE" }
    );
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل حذف النبات اليدوي.");
      setStatus("");
      return;
    }

    await loadLandOps(selectedLandId);
    setStatus("تم حذف النبات من الجرد اليدوي.");
  }

  async function loadImpact(id = selectedLandId) {
    if (!id) return;
    const response = await fetch(`/api/lands/${id}/impact`);
    const payload = await response.json();
    if (response.ok) {
      setImpact(payload);
    }
  }

  async function generateOpsActionPlan() {
    if (!requireAdminAction("توليد خطة التنفيذ")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري توليد خطة تنفيذ AI لمدة 7 أيام...");
    setActionPlan(null);

    const response = await fetch(`/api/lands/${selectedLandId}/action-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, place })
    });

    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "فشل توليد خطة التنفيذ.");
      setStatus("");
      return;
    }

    setActionPlan(payload);
    await loadImpact(selectedLandId);
    setStatus("تم توليد خطة تنفيذ AI.");
  }

  async function generateUnifiedAiDecision() {
    if (!requireAdminAction("توليد القرار الموحد")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري دمج الصور والطقس والحساسات وأوامر الري في قرار AI واحد...");
    setUnifiedDecision(null);

    const response = await fetch(`/api/lands/${selectedLandId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat,
        lon,
        place,
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        tankCapacityLiters: Number(tankCapacityLiters),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد القرار الموحد.");
      setStatus("");
      return;
    }

    setUnifiedDecision(payload);
    await loadLandOps(selectedLandId);
    setStatus("تم توليد قرار AI موحد قابل للعرض والتنفيذ.");
  }

  async function generateIrrigationSchedulePlan() {
    if (!requireAdminAction("توليد جدولة الري")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري توليد جدولة ري ذكية للـ 24 ساعة القادمة...");
    setIrrigationSchedule(null);

    const response = await fetch(`/api/lands/${selectedLandId}/irrigation-schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat,
        lon,
        place,
        tankCapacityLiters: Number(tankCapacityLiters),
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        flowRateLitersPerMinute: Number(flowRate),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد جدولة الري.");
      setStatus("");
      return;
    }

    setIrrigationSchedule(payload);
    await loadLandOps(selectedLandId);
    setStatus(payload.source === "ai"
      ? "تم توليد جدولة الري بالذكاء الاصطناعي."
      : "تم توليد جدولة ري تشغيلية من البيانات بسبب تعذر Gemini.");
  }

  async function generateSensorAiInsight() {
    if (!requireAdminAction("تحليل الحساسات")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري تحليل قراءات ESP32 بالذكاء الاصطناعي...");
    setSensorInsight(null);

    const response = await fetch(`/api/lands/${selectedLandId}/sensor-insight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, place })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تحليل الحساسات.");
      setStatus("");
      return;
    }

    setSensorInsight(payload);
    setStatus(
      payload.telemetryAvailable
        ? "تم توليد تحليل الحساسات بالذكاء الاصطناعي."
      : "تم توليد تحليل AI، لكن جدول قراءات ESP32 غير مطبق بعد في Supabase."
    );
  }

  async function generateHardwareReadinessReport() {
    if (!requireAdminAction("فحص جاهزية العتاد")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري فحص جاهزية ESP32 و MQTT بالذكاء الاصطناعي...");
    setHardwareReadiness(null);

    const response = await fetch(`/api/lands/${selectedLandId}/hardware-readiness`, {
      method: "POST"
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل فحص جاهزية العتاد.");
      setStatus("");
      return;
    }

    setHardwareReadiness(payload);
    setStatus("تم توليد فحص جاهزية العتاد.");
  }

  async function generateFieldWorkOrders() {
    if (!requireAdminAction("توليد أوامر العمل")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري توليد أوامر عمل AI من سجل الأرض...");
    setWorkOrders(null);

    const response = await fetch(`/api/lands/${selectedLandId}/work-orders`, {
      method: "POST"
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد أوامر العمل.");
      setStatus("");
      return;
    }

    setWorkOrders(payload);
    setStatus(payload.saved?.count ? `تم توليد وحفظ ${payload.saved.count} أوامر عمل.` : "تم توليد أوامر العمل.");
  }

  async function generateWeatherRiskInsight() {
    if (!requireAdminAction("توليد تنبيه الطقس والري")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري تحليل الطقس وتأثيره على قرار الري...");
    setWeatherRisk(null);

    const response = await fetch(`/api/lands/${selectedLandId}/weather-risk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, place })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تحليل الطقس والري.");
      setStatus("");
      return;
    }

    setWeatherRisk(payload);
    setStatus("تم توليد تنبيه الطقس والري.");
  }

  async function generateOperatorChecklist() {
    if (!requireAdminAction("توليد مهام المشغل")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري توليد قائمة مهام المشغل...");
    setOperatorChecklist(null);

    const response = await fetch(`/api/lands/${selectedLandId}/operator-checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place, weatherRisk: weatherRisk?.risk ?? null })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد قائمة المهام.");
      setStatus("");
      return;
    }

    setOperatorChecklist(payload);
    setStatus("تم توليد قائمة مهام المشغل.");
  }

  async function generatePestResponse() {
    if (!requireAdminAction("توليد خطة استجابة الآفات")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري توليد خطة استجابة للآفات...");
    setPestResponse(null);

    const response = await fetch(`/api/lands/${selectedLandId}/pest-response`, {
      method: "POST"
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد خطة الآفات.");
      setStatus("");
      return;
    }

    setPestResponse(payload);
    setStatus("تم توليد خطة استجابة الآفات.");
  }

  async function askLandQuestion() {
    if (!requireAdminAction("سؤال AI التشغيلي عن الأرض")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    if (!landQuestion.trim()) {
      setError("اكتب سؤالاً عن الأرض أولاً.");
      return;
    }

    setError("");
    setStatus("جاري سؤال AI عن الأرض...");
    setLandQuestionAnswer(null);

    const response = await fetch(`/api/lands/${selectedLandId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: landQuestion, lat, lon })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل سؤال AI عن الأرض.");
      setStatus("");
      return;
    }

    setLandQuestionAnswer(payload);
    setStatus("تم توليد جواب AI عن الأرض.");
  }

  async function runOperationsAgent() {
    if (!requireAdminAction("تشغيل Agent العمليات")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    if (!agentMessage.trim()) {
      setError("اكتب مهمة واضحة للـ Agent.");
      return;
    }

    setError("");
    setStatus("جاري تشغيل Agent العمليات على بيانات الأرض والخزان والجهاز...");
    setAgentRun(null);

    const response = await fetch(`/api/lands/${selectedLandId}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: agentMessage,
        lat,
        lon,
        flowRateLitersPerMinute: Number(flowRate),
        tankCapacityLiters: Number(tankCapacityLiters),
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تشغيل Agent العمليات.");
      setStatus("");
      return;
    }

    setAgentRun(payload);
    setStatus(payload.source === "gemini_agent" ? "تم تشغيل Agent العمليات من Gemini." : "تم تشغيل Agent احتياطي من قواعد المنصة.");
  }

  async function runDemoWorkflowCheck() {
    if (!requireAdminAction("فحص مسار الديمو")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة حتى يتم فحص مسار الديمو عليها.");
      return;
    }

    setError("");
    setStatus("جاري فحص مسار الديمو من بيانات المنصة...");
    setDemoWorkflowCheck(null);

    const response = await fetch("/api/water-budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        landId: Number(selectedLandId),
        tankCapacityLiters: Number(tankCapacityLiters),
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        flowRateLitersPerMinute: Number(flowRate),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل فحص مسار الديمو.");
      setStatus("");
      return;
    }

    setDemoWorkflowCheck(payload);
    setStatus(`تم فحص مسار الديمو: ${payload.score}/100`);
  }

  async function runIdealDemoDryRun() {
    if (!requireAdminAction("تشغيل الديمو الجاف")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة حتى يتم تشغيل الديمو الجاف عليها.");
      return;
    }

    setError("");
    setStatus("جاري بناء مسار تشغيل كامل بدون حفظ أو MQTT...");
    setIdealDemoRun(null);

    const response = await fetch("/api/water-budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        landId: Number(selectedLandId),
        tankCapacityLiters: Number(tankCapacityLiters),
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        flowRateLitersPerMinute: Number(flowRate),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تشغيل الديمو الجاف.");
      setStatus("");
      return;
    }

    setIdealDemoRun(payload);
    setStatus(payload.readiness?.can_prepare_command
      ? "تم تجهيز مسار تشغيل كامل كـ Dry Run بدون إرسال MQTT."
      : "تم تجهيز الديمو الجاف مع توضيح النواقص قبل التشغيل الحقيقي.");
  }

  async function runAutopilotScan(executeSafeAuto = false) {
    if (!requireAdminAction("تشغيل Autopilot")) return;

    setError("");
    setStatus(executeSafeAuto
      ? "جاري تشغيل Autopilot مع التنفيذ الآمن للأراضي المؤهلة..."
      : "جاري تشغيل Autopilot على بيانات الأراضي...");
    setAutopilotScan(null);

    const response = await fetch("/api/agent/autopilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        landId: selectedLandId ? Number(selectedLandId) : undefined,
        flowRateLitersPerMinute: Number(flowRate),
        tankCapacityLiters: Number(tankCapacityLiters),
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode,
        useTelemetryTank: true,
        moistureThresholdPercent: Number(autoMoistureThresholdPercent),
        executeSafeAuto
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تشغيل Autopilot.");
      setStatus("");
      return;
    }

    setAutopilotScan(payload);
    setStatus(`Autopilot اكتمل: ${payload.score}/100`);
  }

  async function runSmartWorkflow() {
    if (!requireAdminAction("تشغيل الفحص الذكي")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً حتى يشتغل الفحص على بيانات حقيقية.");
      return;
    }

    setError("");
    setStatus("جاري تشغيل الفحص الحقيقي: ميزانية الماء + Autopilot بدون إرسال MQTT...");
    setDemoWorkflowCheck(null);
    setWaterBudget(null);
    setAutopilotScan(null);

    const commonBody = {
      landId: Number(selectedLandId),
      tankCapacityLiters: Number(tankCapacityLiters),
      tankAvailableLiters: Number(tankCurrentLiters),
      tankDailyRefillLiters: Number(tankDailyRefillLiters),
      tankReserveLiters: Number(tankReserveLiters),
      flowRateLitersPerMinute: Number(flowRate),
      waterSavingPercent: Number(waterSavingPercent),
      irrigationMode,
      useTelemetryTank: true,
      moistureThresholdPercent: Number(autoMoistureThresholdPercent)
    };

    const [waterBudgetResponse, autopilotResponse] = await Promise.all([
      fetch("/api/water-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(commonBody)
      }),
      fetch("/api/agent/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...commonBody, executeSafeAuto: false })
      })
    ]);

    const [waterBudgetPayload, autopilotPayload] = await Promise.all([
      waterBudgetResponse.json(),
      autopilotResponse.json()
    ]);

    if (!waterBudgetResponse.ok || !autopilotResponse.ok) {
      setError(
        waterBudgetPayload.error
        ?? autopilotPayload.error
        ?? "فشل تشغيل الفحص الذكي."
      );
      setStatus("");
      return;
    }

    setDemoWorkflowCheck(null);
    setWaterBudget(waterBudgetPayload);
    setAutopilotScan(autopilotPayload);
    await loadLandOps(selectedLandId);
    setStatus(`اكتمل الفحص الحقيقي: الجاهزية ${Number(autopilotPayload.score ?? 0).toFixed(0)}/100، ومصدر الخزان إدخال يدوي.`);
  }

  async function copyLandQuestionAnswer() {
    if (!landQuestionAnswer) return;

    const lines = [
      `السؤال: ${landQuestion}`,
      `الجواب: ${landQuestionAnswer.answer.answer}`,
      `الثقة: ${Number(landQuestionAnswer.answer.confidence ?? 0).toFixed(2)}`,
      `الخطوة التالية: ${landQuestionAnswer.answer.recommended_next_step}`,
      landQuestionAnswer.answer.evidence_used.length
        ? `الأدلة: ${landQuestionAnswer.answer.evidence_used.map((item) => `${item.source}: ${item.detail}`).join(" / ")}`
        : "",
      landQuestionAnswer.answer.missing_data.length
        ? `بيانات ناقصة: ${landQuestionAnswer.answer.missing_data.join(" / ")}`
        : ""
    ].filter(Boolean);

    await navigator.clipboard.writeText(lines.join("\n\n"));
    setStatus("تم نسخ جواب الأرض.");
  }

  async function copyOperatorChecklist() {
    if (!operatorChecklist) return;

    const lines = [
      operatorChecklist.checklist.title,
      `الأولوية: ${operatorChecklist.checklist.overall_priority}`,
      operatorChecklist.checklist.operator_summary,
      "",
      ...operatorChecklist.checklist.checklist.map((task) => (
        `${task.step}. ${task.task} | ${task.owner} | ${task.priority} | ${task.time_window}\nالدليل: ${task.evidence}\nينتهي عند: ${task.done_when}`
      )),
      "",
      operatorChecklist.checklist.do_not_do.length
        ? `لا تفعل: ${operatorChecklist.checklist.do_not_do.join(" / ")}`
        : "",
      `ملاحظة المدير: ${operatorChecklist.checklist.manager_note}`
    ].filter(Boolean);

    await navigator.clipboard.writeText(lines.join("\n\n"));
    setStatus("تم نسخ مهام المشغل.");
  }

  async function generateEvidenceReport() {
    if (!requireAdminAction("توليد تقرير دليل الأرض")) return;
    if (!selectedLandId) {
      setError("اختر أرض محفوظة أولاً.");
      return;
    }

    setError("");
    setStatus("جاري توليد تقرير دليل الأرض بالذكاء الاصطناعي...");
    setEvidenceReport(null);

    const response = await fetch(`/api/lands/${selectedLandId}/evidence-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, place })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد تقرير دليل الأرض.");
      setStatus("");
      return;
    }

    setEvidenceReport(payload);
    setStatus("تم توليد تقرير دليل الأرض للعرض.");
  }

  async function generateJudgeDemoReport() {
    setError("");
    setStatus("جاري توليد تقرير العرض للحكام...");
    setJudgeReport(null);

    const response = await fetch("/api/judge-report", {
      method: "POST"
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد تقرير الحكام.");
      setStatus("");
      return;
    }

    setJudgeReport(payload);
    setStatus("تم توليد تقرير عرض الحكام.");
  }

  async function generateReadinessReport() {
    setError("");
    setStatus("جاري تقييم جاهزية العرض بالذكاء الاصطناعي...");
    setReadiness(null);

    const response = await fetch("/api/readiness", { method: "POST" });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تقييم الجاهزية.");
      setStatus("");
      return;
    }

    setReadiness(payload);
    setStatus("تم توليد تقييم جاهزية العرض.");
  }

  async function generateDemoRunbookPlan() {
    setError("");
    setStatus("جاري توليد Runbook العرض للحكام من بيانات المنصة الحقيقية...");
    setDemoRunbook(null);

    const response = await fetch("/api/readiness", { method: "POST" });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد Runbook العرض.");
      setStatus("");
      return;
    }

    setDemoRunbook(payload);
    setStatus(payload.source === "gemini"
      ? "تم توليد Runbook العرض بالذكاء الاصطناعي."
      : "تم توليد Runbook العرض من قواعد المنصة بسبب ضغط Gemini.");
  }

  async function generateDailyOpsBrief() {
    if (!requireAdminAction("توليد موجز الإدارة")) return;
    setError("");
    setStatus("جاري توليد موجز اليوم بالذكاء الاصطناعي...");
    setDailyBrief(null);

    const response = await fetch("/api/daily-brief", { method: "POST" });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد موجز اليوم.");
      setStatus("");
      return;
    }

    setDailyBrief(payload);
    setStatus("تم توليد موجز اليوم.");
  }

  async function generatePortfolioPriorityPlan() {
    if (!requireAdminAction("ترتيب أولويات الأراضي")) return;
    setError("");
    setStatus("جاري ترتيب أولويات الأراضي بالذكاء الاصطناعي...");
    setPortfolioPriority(null);

    const response = await fetch("/api/portfolio-priority", { method: "POST" });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل توليد أولويات الأراضي.");
      setStatus("");
      return;
    }

    setPortfolioPriority(payload);
    setStatus("تم توليد ترتيب أولويات الأراضي.");
  }

  async function generateWaterBudgetPlan() {
    if (!requireAdminAction("حساب ميزانية الماء")) return;
    setError("");

    if (selectedPottedPlantId) {
      setStatus("جاري حساب توصية ري النبات المختار من صورته المحفوظة وآخر قراءة ESP32...");
      setWaterBudget(null);

      let targetLandId = Number(selectedPottedPlant?.linked_land_id);
      if (!Number.isFinite(targetLandId) || targetLandId <= 0) {
        const targetResponse = await fetch(`/api/potted-plants/${selectedPottedPlantId}/ensure-target`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: Number(lat),
            lon: Number(lon),
            owner_id: currentUser?.id,
            auto_irrigation_enabled: autoIrrigationEnabled
          })
        });
        const targetPayload = await targetResponse.json();

        if (!targetResponse.ok) {
          setError(targetPayload.error ?? "فشل تجهيز هدف النبات قبل حساب الري.");
          setStatus("");
          return;
        }

        targetLandId = Number(targetPayload.land?.id);
        if (Number.isFinite(targetLandId) && targetLandId > 0) {
          setSelectedLandId(String(targetLandId));
          if (targetPayload.land) {
            applyLandFields(targetPayload.land);
          }
        }
      }

      const response = await fetch(`/api/potted-plants/${selectedPottedPlantId}/reanalyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowRateLitersPerMinute: Number(flowRate)
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "فشل حساب توصية ري النبات المختار.");
        setStatus("");
        return;
      }

      setPottedPlantResult(payload);
      await loadPottedPlants(currentUser?.id);
      const linkedLandId = Number(payload.plant?.linked_land_id || targetLandId);
      if (Number.isFinite(linkedLandId) && linkedLandId > 0) {
        setSelectedLandId(String(linkedLandId));
        await loadLandOps(String(linkedLandId));
      }
      setStatus(`تم حساب توصية ري النبات ${payload.plant?.name ?? ""}: ${Number(payload.commandPreview?.liters_to_apply_now ?? 0).toFixed(2)} L.`);
      return;
    }

    setStatus("جاري حساب ميزانية الماء وتوزيع الخزان على الأراضي...");
    setWaterBudget(null);

    const response = await fetch("/api/water-budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tankCapacityLiters: Number(tankCapacityLiters),
        tankAvailableLiters: Number(tankCurrentLiters),
        tankDailyRefillLiters: Number(tankDailyRefillLiters),
        tankReserveLiters: Number(tankReserveLiters),
        flowRateLitersPerMinute: Number(flowRate),
        waterSavingPercent: Number(waterSavingPercent),
        irrigationMode,
        useTelemetryTank: true,
        moistureThresholdPercent: Number(autoMoistureThresholdPercent)
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل حساب ميزانية الماء.");
      setStatus("");
      return;
    }

    setWaterBudget(payload);
    setStatus(`تم حساب ميزانية الماء: المطلوب ${Number(payload.summary?.total_required_liters ?? 0).toFixed(1)} L.`);
  }

  async function approveWaterBudgetDispatch(item: WaterBudgetResult["dispatch_order"][number]) {
    if (!requireAdminAction("اعتماد دفعة من ميزانية الماء")) return;
    const durationSeconds = Number(item.safe_batch_duration_seconds ?? 0);
    const litersTarget = Number(item.safe_batch_liters ?? 0);

    if (!item.device_uid) {
      setError("لا يمكن إرسال هذه الدفعة: لا يوجد ESP32 فعال مرتبط بهذه الأرض.");
      return;
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1800 || litersTarget <= 0) {
      setError("هذه الدفعة غير آمنة للإرسال. راجع تخصيص الماء أو معدل التدفق.");
      return;
    }

    setError("");
    setStatus(`جاري اعتماد دفعة ميزانية الماء لأرض ${item.land_name}...`);

    const response = await fetch("/api/iot/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        land_id: item.land_id,
        device_uid: item.device_uid,
        duration_seconds: durationSeconds,
        liters_target: litersTarget,
        batch: 1,
        batch_total: item.unmet_liters > 0 ? 2 : 1,
        reason: `Water budget dispatch for ${item.land_name}`
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.commandId
        ? `تم حفظ أمر الميزانية لكن أوقفه مسار الأمان رقم ${payload.commandId}: ${payload.error}`
        : payload.error ?? "فشل إرسال دفعة ميزانية الماء.");
      setStatus("");
      return;
    }

    await loadDashboard();
    if (selectedLandId) await loadLandOps(selectedLandId);
    setStatus(`تم نشر دفعة ميزانية الماء رقم ${payload.commandId} إلى ${payload.topic}`);
  }

  async function calculateRoi() {
    setError("");
    setStatus("جاري حساب أثر المنصة وتوليد شرح AI...");
    setRoi(null);

    const response = await fetch("/api/roi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        waterCostPerLiter,
        laborCostPerInspection,
        avoidedInspections
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل حساب الأثر.");
      setStatus("");
      return;
    }

    setRoi(payload);
    setStatus("تم حساب أثر المنصة.");
  }

  async function triageNote() {
    if (!requireAdminAction("تشخيص الملاحظة الميدانية")) return;
    setError("");
    setStatus("جاري تشخيص الملاحظة الميدانية بالذكاء الاصطناعي...");
    setFieldTriage(null);

    const response = await fetch("/api/field-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: fieldNote,
        landId: selectedLandId || undefined,
        landName,
        cropHint,
        areaM2,
        lat,
        lon,
        place,
        hasRecentImageAnalysis: Boolean(result),
        hasIotDevice: Boolean(deviceUid)
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(payload.error ?? "فشل تشخيص الملاحظة.");
      setStatus("");
      return;
    }

    setFieldTriage(payload);
    if (selectedLandId) await loadLandOps(selectedLandId);
    if (selectedLandId) await loadImpact(selectedLandId);
    setStatus("تم تشخيص الملاحظة الميدانية.");
  }

  async function saveLand() {
    if (!requireAdminAction("حفظ الأرض")) return;
    setError("");

    if (selectedPottedPlantId) {
      setStatus("جاري تجهيز حدود النبات من تحليل AI وتفعيل الري التلقائي له...");
      const response = await fetch(`/api/potted-plants/${selectedPottedPlantId}/ensure-target`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: Number(lat),
          lon: Number(lon),
          owner_id: currentUser?.id,
          auto_irrigation_enabled: autoIrrigationEnabled
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "فشل تجهيز هدف النبات للري التلقائي.");
        setStatus("");
        return;
      }

      setSelectedLandId(String(payload.land.id));
      setAreaM2(String(Number(payload.areaM2 ?? payload.land.area_m2 ?? 0).toFixed(2)));
      setLandGeojson(JSON.stringify(payload.boundary));
      setPolygonPoints(geojsonToPolygon(payload.boundary));
      await loadLands(currentUser?.id);
      await loadPottedPlants(currentUser?.id);
      await loadDashboard();
      await loadLandOps(String(payload.land.id));
      await loadImpact(String(payload.land.id));
      setStatus(`تم تجهيز حدود النبات من AI وتحديث الري التلقائي. المساحة المحسوبة ${Number(payload.areaM2 ?? 0).toFixed(2)} م2.`);
      return;
    }

    const isUpdatingLand = Boolean(selectedLandId);
    setStatus(isUpdatingLand ? "جاري تحديث الأرض المختارة في Supabase..." : "جاري حفظ الأرض في Supabase...");

    if (!landGeojson || polygonPoints.length < 3) {
      setError("حدد حدود الأرض على الخريطة أولاً.");
      setStatus("");
      return;
    }

    const response = await fetch("/api/lands", {
      method: isUpdatingLand ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: selectedLandId ? Number(selectedLandId) : undefined,
        name: landName,
        crop_hint: cropHint,
        boundary_geojson: JSON.parse(landGeojson),
        auto_irrigation_enabled: autoIrrigationEnabled,
        owner_id: currentUser?.id,
        requester_id: currentUser?.id
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "فشل حفظ الأرض.");
      setStatus("");
      return;
    }

    setStatus(payload.updated ? `تم تحديث الأرض رقم ${payload.land.id}` : `تم حفظ الأرض رقم ${payload.land.id}`);
    setSelectedLandId(String(payload.land.id));
    await loadLands(currentUser?.id);
    await loadDashboard();
    await loadLandOps(String(payload.land.id));
    await loadImpact(String(payload.land.id));
  }

  function openSection(section: ActiveSection) {
    if (section === "demo") {
      setWorkspaceMode("admin");
      setActiveSection("ops");
      setOpsView("overview");
      return;
    }
    if ((section === "admin" || section === "settings") && currentProfile?.role !== "admin") {
      setWorkspaceMode("user");
      setActiveSection("map");
      setStatus("هذا القسم مخصص للمدير فقط.");
      return;
    }
    setActiveSection(section);
    if (section === "admin" || section === "settings") setWorkspaceMode("admin");
    if (section === "ops") setWorkspaceMode(currentProfile?.role === "admin" ? "admin" : "user");
    if (section !== "admin" && section !== "settings" && section !== "ops") setWorkspaceMode("user");
  }

  function openOpsView(view: OpsView) {
    if (currentProfile?.role !== "admin") {
      openSection("ops");
      return;
    }
    setWorkspaceMode("admin");
    setActiveSection("ops");
    setOpsView(view);
  }

  const fullReadyDemo = {
    metrics: [
      { label: "الأرض", value: "1,200 م2", note: "حدود مرسومة من القمر الصناعي ومحفوظة GeoJSON" },
      { label: "النباتات", value: "2 نخلة", note: "جرد يدوي معتمد + صور درون للتأكيد" },
      { label: "الطقس", value: "0.0 mm مطر", note: "OpenWeather forecast للأيام القادمة" },
      { label: "الري", value: "240 L / نخلة", note: "رية كل 3 أيام، ليست يومية" }
    ],
    flow: [
      {
        title: "1. تحديد الأرض",
        status: "جاهز",
        detail: "المدير يرسم حدود الأرض على طبقة القمر الصناعي، يحسب النظام المساحة والمركز، ويحفظ الأرض في Supabase."
      },
      {
        title: "2. ربط المستخدم",
        status: "جاهز",
        detail: "Admin يضيف صاحب الأرض ويربطه بهذه القطعة فقط، والمستخدم يرى حالتها بدون صلاحية تشغيل الصمامات."
      },
      {
        title: "3. صور الدرون والهاتف",
        status: "جاهز",
        detail: "ترفع الصور للأرض، النظام يحذف المكررات، ويجمع نتائج كل الصور بدل الاعتماد على صورة واحدة."
      },
      {
        title: "4. تحليل Gemini",
        status: "جاهز",
        detail: "Gemini يحدد النباتات، يفحص مؤشرات سوسة النخيل الحمراء، ويرجع JSON منظم قابل للحفظ والتدقيق."
      },
      {
        title: "5. قرار الري",
        status: "جاهز",
        detail: "المحرك يحسب المتوسط اليومي وكمية الرية الواحدة وفاصل الري، ثم يخصم المطر المتوقع."
      },
      {
        title: "6. أمر IoT",
        status: "جاهز للتنفيذ",
        detail: "إذا الأرض مستحقة والـ ESP32 متصل، يرسل النظام أمر MQTT للفتح لمدة محددة ثم ينتظر ACK وقراءات الحساس."
      }
    ],
    command: {
      topic: "agriai/lands/2/valve/cmd",
      payload: {
        land_id: 2,
        device_uid: "esp32-land-2-valve-01",
        status: "ON",
        duration_seconds: 2880,
        liters_target: 480,
        reason: "2 نخلة × 240 لتر لكل نخلة، رية كل 3 أيام، لا يوجد مطر مؤثر",
        safety: {
          auto_irrigation_enabled: true,
          requires_ack: true,
          max_duration_seconds: 3600
        }
      }
    }
  };

  const demoPlantSummary = idealDemoRun?.plants?.length
    ? idealDemoRun.plants.map((plant) => `${plant.name}: ${Number(plant.count ?? 0).toFixed(0)}`).join(" / ")
    : selectedLand
      ? "يشغل Dry Run حتى يظهر جرد النبات الحقيقي"
      : "اختر أرض محفوظة";
  const demoCommandDuration = Math.min(
    1800,
    Math.max(0, idealDemoRun?.command_preview?.duration_seconds ?? Math.ceil((demoTargetLiters / Math.max(0.1, Number(flowRate) || 10)) * 60))
  );
  const demoCommandLiters = Math.max(
    0,
    idealDemoRun?.command_preview?.liters_target ?? Math.min(demoTargetLiters, Math.max(0, (Number(flowRate) || 10) * (demoCommandDuration / 60)))
  );
  const dynamicReadyDemo = {
    ...fullReadyDemo,
    metrics: [
      {
        label: "الأرض",
        value: idealDemoRun?.land?.area_m2
          ? `${Number(idealDemoRun.land.area_m2).toFixed(0)} م2`
          : selectedLand
            ? `${Number(selectedLand.area_m2 ?? areaM2).toFixed(0)} م2`
            : `${Number(areaM2 || 0).toFixed(0)} م2`,
        note: selectedLand ? `${selectedLand.name} / حدود محفوظة GeoJSON` : "اختر أرض محفوظة حتى يرتبط الديمو ببيانات حقيقية"
      },
      {
        label: "النباتات",
        value: demoPlantSummary,
        note: idealDemoRun?.plants?.length ? "من جرد يدوي موثوق أو تجميع صور محفوظة بدون تكرار" : "Dry Run يقرأ الجرد الفعلي من Supabase"
      },
      {
        label: "الطقس",
        value: `${Number(idealDemoRun?.weather?.forecastRainMm ?? 0).toFixed(1)} mm مطر`,
        note: idealDemoRun?.weather ? "OpenWeather forecast للأرض المختارة" : "يشغل Dry Run حتى يتم جلب الطقس الحي"
      },
      {
        label: "قرار الري",
        value: `${demoPlannedLiters.toFixed(1)} L / كل ${demoIntervalDays.toFixed(0)} يوم`,
        note: `الخام ${demoRawLiters.toFixed(1)} L، خطة توفير ${demoSavingPercent.toFixed(0)}%، والدفعة الآمنة ${demoTargetLiters.toFixed(1)} L`
      }
    ],
    command: {
      topic: idealDemoRun?.device?.topic ?? `agriai/lands/${selectedLandId || "demo"}/valve/cmd`,
      payload: {
        ...fullReadyDemo.command.payload,
        land_id: Number(selectedLandId || idealDemoRun?.land?.id || 0),
        device_uid: idealDemoRun?.device?.uid ?? (deviceUid || "esp32-ready-valve"),
        duration_seconds: demoCommandDuration,
        liters_target: Number(demoCommandLiters.toFixed(2)),
        reason: `خطة اقتصادية: الخام ${demoRawLiters.toFixed(1)} L، المخطط ${demoPlannedLiters.toFixed(1)} L كل ${demoIntervalDays.toFixed(0)} يوم، الدفعة الآمنة ${demoCommandLiters.toFixed(1)} L`,
        safety: {
          ...fullReadyDemo.command.payload.safety,
          auto_irrigation_enabled: idealDemoRun?.land?.auto_irrigation_enabled ?? false,
          max_duration_seconds: 1800,
          water_saving_percent: demoSavingPercent,
          tank_reserve_liters: demoTankReserve
        }
      }
    }
  };

  const liveIrrigation = useMemo(() => {
    const latestCommand = landOps?.recent.commands?.[0] ?? null;
    const commandUuid = latestCommand?.payload?.command_id ?? null;
    const matchingTelemetry = landOps?.recent.telemetry?.find((reading) => {
      const activeCommandId = reading.raw_payload?.active_command_id;
      return commandUuid && activeCommandId === commandUuid;
    }) ?? null;
    const ack = latestCommand?.ack_payload ?? null;
    const commandHasDeviceProof = Boolean(ack?.status || matchingTelemetry);
    const telemetryPayload = matchingTelemetry?.raw_payload ?? {};
    const progress = Math.max(0, Math.min(100, Number(
      commandHasDeviceProof
        ? ack?.progress_percent
          ?? telemetryPayload.progress_percent
          ?? 0
        : 0
    )));
    const duration = Number(
      ack?.duration_seconds
      ?? latestCommand?.payload?.duration_seconds
      ?? 0
    );
    const elapsed = Number(
      commandHasDeviceProof
        ? ack?.elapsed_seconds
          ?? telemetryPayload.elapsed_seconds
          ?? 0
        : 0
    );
    const remaining = Number(
      commandHasDeviceProof
        ? ack?.remaining_seconds
          ?? telemetryPayload.remaining_seconds
          ?? Math.max(0, duration - elapsed)
        : duration
    );
    const spent = Number(
      commandHasDeviceProof
        ? ack?.water_spent_liters
          ?? telemetryPayload.water_spent_liters
          ?? 0
        : 0
    );
    const target = Number(latestCommand?.payload?.liters_target ?? 0);
    const flow = Number(commandHasDeviceProof ? ack?.flow_liters_per_minute ?? matchingTelemetry?.flow_liters_per_minute ?? 0 : 0);
    const ackStatus = String(ack?.status ?? "").toLowerCase();
    const commandStatus = String(latestCommand?.status ?? "no_command").toLowerCase();
    const commandPayload = latestCommand?.payload as { status?: string } | null | undefined;
    const payloadStatus = String(commandPayload?.status ?? "").toUpperCase();
    const relayState = commandHasDeviceProof ? ack?.relay_state ?? matchingTelemetry?.valve_state ?? "OFF" : "UNKNOWN";
    const received = Boolean(commandHasDeviceProof || ack?.first_ack_at || ack?.received_at || latestCommand?.acknowledged_at);
    const stopped = received && (ackStatus === "forced_off" || (payloadStatus === "OFF" && relayState === "OFF"));
    const running = received && !stopped && (relayState === "ON" || ackStatus === "started" || ackStatus === "progress" || commandStatus === "running");
    const completed = received && (stopped || ackStatus === "completed" || commandStatus === "completed");
    const failed = commandStatus === "failed" || ackStatus.includes("rejected") || ackStatus.includes("failed");
    const awaitingAck = Boolean(latestCommand && !received && !failed);
    const deviceConnectionStatus = landOps?.summary.deviceConnectionStatus ?? "not_registered";
    const fallbackMessage = awaitingAck
      ? deviceConnectionStatus === "online"
        ? "تم نشر الأمر، لكن لم يصل ACK من ESP32 لهذا الأمر بعد."
        : deviceConnectionStatus === "offline"
          ? "تم نشر الأمر، لكن ESP32 غير متصل حالياً ولم يؤكد استلامه."
          : "تم نشر الأمر، لكن لا يوجد ESP32 مسجل/متصل لتأكيد التنفيذ."
      : "";

    return {
      command: latestCommand,
      telemetry: matchingTelemetry,
      commandUuid,
      commandHasDeviceProof,
      awaitingAck,
      deviceConnectionStatus,
      received,
      running,
      completed,
      stopped,
      failed,
      status: failed ? "failed" : completed ? "completed" : running ? "running" : received ? "received" : awaitingAck ? "awaiting" : latestCommand ? commandStatus : "idle",
      progress,
      duration: Number.isFinite(duration) ? duration : 0,
      elapsed: Number.isFinite(elapsed) ? elapsed : 0,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      spent: Number.isFinite(spent) ? spent : 0,
      target: Number.isFinite(target) ? target : 0,
      flow: Number.isFinite(flow) ? flow : 0,
      relayState,
      ackStatus: ack?.status ?? null,
      message: ack?.message ?? ack?.error ?? ack?.safety_review?.operator_message ?? fallbackMessage,
      history: ack?.ack_history ?? []
    };
  }, [landOps]);

  const deviceStatusLabel = landOps?.summary.deviceConnectionStatus === "online"
    ? "متصل الآن"
    : landOps?.summary.deviceConnectionStatus === "offline"
      ? "غير متصل"
      : "غير مسجل";
  const deviceStatusTone = landOps?.summary.deviceConnectionStatus === "online"
    ? "ok"
    : landOps?.summary.deviceConnectionStatus === "offline"
      ? "danger"
      : "warn";
  const operationalAlert = useMemo(() => selectedLandId && landOps
    ? liveIrrigation.awaitingAck
      ? {
          tone: "danger",
          title: "أمر ري منشور بدون تأكيد من ESP32",
          detail: liveIrrigation.message || "لا تعتبر الري منفذاً حتى يصل ACK أو telemetry بنفس رقم الأمر."
        }
      : landOps.summary.deviceConnectionStatus !== "online"
        ? {
            tone: landOps.summary.deviceConnectionStatus === "offline" ? "danger" : "warn",
            title: landOps.summary.deviceConnectionStatus === "offline" ? "ESP32 غير متصل" : "لا يوجد ESP32 مسجل",
            detail: landOps.summary.deviceConnectionStatus === "offline"
              ? `آخر ظهور: ${landOps.summary.latestDeviceSeenAt ? new Date(landOps.summary.latestDeviceSeenAt).toLocaleString("ar-IQ") : "غير معروف"}. أوامر الري موقوفة حتى يرجع الجهاز يرسل telemetry.`
              : "جهّز ESP32 لهذه الأرض وانتظر أول telemetry قبل إرسال أي أمر ري."
          }
        : null
    : null, [selectedLandId, landOps, liveIrrigation.awaitingAck, liveIrrigation.message]);

  useEffect(() => {
    if (!selectedLandId || !landOps) return;
    if (!operationalAlert) return;

    const key = `${selectedLandId}:${operationalAlert.title}:${liveIrrigation.command?.id ?? "no-command"}`;
    if (lastDeviceToastRef.current === key) return;
    lastDeviceToastRef.current = key;

    const id = Date.now();
    if (deviceToastTimerRef.current) {
      window.clearTimeout(deviceToastTimerRef.current);
    }
    setToast({ id, type: operationalAlert.tone === "danger" ? "error" : "info", message: `${operationalAlert.title}: ${operationalAlert.detail}` });
    deviceToastTimerRef.current = window.setTimeout(() => {
      setToast((current) => current?.id === id ? null : current);
      deviceToastTimerRef.current = null;
    }, operationalAlert.tone === "danger" ? 8000 : 5600);
  }, [selectedLandId, landOps, operationalAlert, liveIrrigation.command?.id]);

  const toastNode = toast ? (
    <div className="toastViewport" role="status" aria-live="polite" dir="rtl">
      <div className={`toast toast-${toast.type}`}>
        <span>{toast.type === "error" ? "خطأ" : toast.type === "info" ? "جاري التنفيذ" : "تم"}</span>
        <strong>{toast.message}</strong>
        <button className="toastClose" onClick={() => setToast(null)} aria-label="إغلاق الإشعار">×</button>
      </div>
    </div>
  ) : null;

  if (!authReady) {
    return (
      <main className="loginShell" dir="rtl">
        {toastNode}
        <section className="loginCard">
          <span className="loginKicker">AgriAI Control</span>
          <h1>جاري تجهيز منصة الدخول...</h1>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="loginShell" dir="rtl">
        {toastNode}
        <section className="loginCard">
          <div>
            <span className="loginKicker">AgriAI Control</span>
            <h1>تسجيل دخول المنصة</h1>
            <p>ادخل بحسابك المصرح من مدير المنصة لمتابعة الأراضي، النباتات، الحساسات، والري.</p>
          </div>
          <div className="loginForm">
            <label>
              البريد الإلكتروني
              <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="user@example.com" />
            </label>
            <label>
              كلمة المرور
              <input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="******" />
            </label>
            <button onClick={signIn}>تسجيل الدخول</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="appShell">
      {toastNode}
      <section className="heroBand">
        <div>
          <p className="eyebrow">AgriAI Operations Center</p>
          <h1>مركز مراقبة وتحليل وسيطرة زراعي</h1>
          <p className="heroSubcopy">خرائط، صور، ذكاء اصطناعي، خزان محدود، و ESP32 في شاشة تشغيل واحدة.</p>
        </div>
        <div className="heroControls">
          <div className="workspaceSwitch" aria-label="اختيار مساحة العمل">
            <button
              className={workspaceMode === "user" ? "active" : ""}
              onClick={() => openSection("map")}
            >
              المستخدم
            </button>
            {currentProfile?.role === "admin" ? (
              <button
                className={workspaceMode === "admin" ? "active" : ""}
                onClick={() => openSection("admin")}
              >
                Admin
              </button>
            ) : null}
          </div>
          <div className="accountPill">
            <span>{currentProfile?.full_name ?? currentUser.email}</span>
            <strong>{currentProfile?.role ?? "user"}</strong>
            <button className="miniButton" onClick={signOut}>تسجيل الخروج</button>
          </div>
          <div className={missing.length ? "serviceBadge warn" : "serviceBadge ok"}>
            <span>حالة الخدمات</span>
            <strong>{missing.length ? `${missing.length} ناقصة` : "جاهزة"}</strong>
          </div>
        </div>
      </section>

      <div className="appLayout">
        <aside className="sideNav" aria-label="قائمة المنصة">
          <div className="sideNavTitle">
            <span>القائمة</span>
            <strong>{workspaceMode === "admin" ? "Admin" : "المستخدم"}</strong>
          </div>
          <button className={activeSection === "assets" ? "active navButton" : "navButton"} onClick={() => openSection("assets")}>
            <span>الموجودات</span>
            <strong>الأراضي والنباتات</strong>
          </button>
          <button className={activeSection === "map" ? "active navButton" : "navButton"} onClick={() => openSection("map")}>
            <span>الأراضي</span>
            <strong>الخريطة والحفظ</strong>
          </button>
          <button className={activeSection === "field" ? "active navButton" : "navButton"} onClick={() => openSection("field")}>
            <span>البيانات</span>
            <strong>التحليل والجرد</strong>
          </button>
          {currentProfile?.role === "admin" ? (
            <>
              <div className="sideNavGroupLabel">التشغيل</div>
              <button className={activeSection === "ops" && opsView === "overview" ? "active navButton" : "navButton"} onClick={() => openOpsView("overview")}>
                <span>لوحة القرار</span>
                <strong>نظرة تشغيلية</strong>
              </button>
              <button className={activeSection === "ops" && opsView === "recommendations" ? "active navButton" : "navButton"} onClick={() => openOpsView("recommendations")}>
                <span>الماء والخزان</span>
                <strong>توصيات الري</strong>
              </button>
              <button className={activeSection === "ops" && opsView === "auto" ? "active navButton" : "navButton"} onClick={() => openOpsView("auto")}>
                <span>AI Autopilot</span>
                <strong>الري التلقائي</strong>
              </button>
              <button className={activeSection === "ops" && opsView === "manual" ? "active navButton" : "navButton"} onClick={() => openOpsView("manual")}>
                <span>تحكم المدير</span>
                <strong>الري اليدوي</strong>
              </button>
              <button className={activeSection === "ops" && opsView === "hardware" ? "active navButton" : "navButton"} onClick={() => openOpsView("hardware")}>
                <span>الجهاز والريلي</span>
                <strong>ESP32</strong>
              </button>
              <button className={activeSection === "ops" && opsView === "live" ? "active navButton" : "navButton"} onClick={() => openOpsView("live")}>
                <span>ACK و Telemetry</span>
                <strong>المراقبة الحية</strong>
              </button>
              <button className={activeSection === "ops" && opsView === "ai" ? "active navButton" : "navButton"} onClick={() => openOpsView("ai")}>
                <span>تحليل وتقارير</span>
                <strong>أدوات AI</strong>
              </button>
            </>
          ) : (
            <button className={activeSection === "ops" ? "active navButton" : "navButton"} onClick={() => openSection("ops")}>
              <span>حالة الأرض</span>
              <strong>مركز العمليات</strong>
            </button>
          )}
          {false && currentProfile?.role === "admin" ? (
            <button className={activeSection === "demo" ? "active" : ""} onClick={() => openSection("demo")}>
              تشغيل كامل جاهز
            </button>
          ) : null}
          {currentProfile?.role === "admin" ? (
            <button className={activeSection === "admin" ? "active navButton" : "navButton"} onClick={() => openSection("admin")}>
              <span>المستخدمون</span>
              <strong>لوحة Admin</strong>
            </button>
          ) : null}
          {currentProfile?.role === "admin" ? (
            <button className={activeSection === "settings" ? "active navButton" : "navButton"} onClick={() => openSection("settings")}>
              <span>الخدمات</span>
              <strong>الإعدادات</strong>
            </button>
          ) : null}
        </aside>

        <div className="appContent">

      <section className="workspaceIntro">
        <div>
          <span>{workspaceMode === "user" ? "مساحة المستخدم" : "مساحة Admin"}</span>
          <strong>
            {workspaceMode === "user"
              ? "عرض حالة الأرض، صحة النباتات، الآفات، الري، وسجل الأجهزة"
              : "متابعة المحفظة، الأولويات، الأثر، وتجهيز التشغيل"}
          </strong>
        </div>
      </section>

      <section className="commandDeck" aria-label="لوحة مراقبة مختصرة">
        <div className="commandCard">
          <span>{selectedPottedPlant ? "النبات النشط" : "الأرض النشطة"}</span>
          <strong>{selectedPottedPlant?.name ?? selectedLand?.name ?? "لم يتم اختيار هدف"}</strong>
          <small>
            {selectedPottedPlant
              ? `${selectedPottedPlant.location_label ?? "نبات فردي"} / ${selectedPottedPlant.linked_land_id ? `مرتبط بـ ${landOps?.recent.devices.find((device) => device.is_active)?.device_uid ?? "ESP32"}` : "بدون حساس مرتبط"}`
              : selectedLand
                ? `${Number(selectedLand.area_m2 ?? 0).toLocaleString("ar-IQ")} م2 / ${selectedLand.crop_hint ?? "محصول غير محدد"}`
                : "اختر أرضاً أو نباتاً محفوظاً."}
          </small>
        </div>
        <div className={`commandCard state-${deviceStatusTone}`}>
          <span>اتصال ESP32</span>
          <strong>{selectedLandId ? deviceStatusLabel : selectedPottedPlant ? "النبات غير مربوط" : "بانتظار اختيار أرض"}</strong>
          <small>
            {landOps?.summary.latestDeviceSeenAt
              ? `آخر ظهور ${new Date(landOps.summary.latestDeviceSeenAt).toLocaleString("ar-IQ")}`
              : selectedLandId ? "لا توجد telemetry حديثة" : selectedPottedPlant ? "اربط ESP32 بهذا النبات من قائمة الأجهزة" : "لا يوجد جهاز محدد"}
          </small>
        </div>
        <div className="commandCard">
          <span>الخزان اليدوي</span>
          <strong>{Number(tankCurrentLiters || 0).toLocaleString("ar-IQ")} L</strong>
          <small>السعة {Number(tankCapacityLiters || 0).toLocaleString("ar-IQ")} L / الاحتياطي {Number(tankReserveLiters || 0).toLocaleString("ar-IQ")} L</small>
        </div>
        <div className={`commandCard ${missing.length ? "state-warn" : "state-ok"}`}>
          <span>جاهزية الخدمات</span>
          <strong>{missing.length ? `${missing.length} ناقصة` : "جاهزة"}</strong>
          <small>{missing.length ? missing.slice(0, 2).join(" / ") : "Supabase و AI والطقس مفعلة"}</small>
        </div>
      </section>

      {operationalAlert ? (
        <section className={`operationalAlert alert-${operationalAlert.tone}`} role="alert">
          <div>
            <span>تنبيه عمليات</span>
            <strong>{operationalAlert.title}</strong>
            <p>{operationalAlert.detail}</p>
          </div>
          <div className="alertActions">
            <button className="secondary" onClick={() => selectedLandId ? loadLandOps(selectedLandId) : undefined} disabled={!selectedLandId}>
              تحديث الحالة
            </button>
            {isAdmin ? (
              <button className="secondary" onClick={registerEsp32Device} disabled={!selectedLandId}>
                تجهيز ESP32
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className={`assetCenter ${activeSection === "assets" ? "" : "sectionHidden"}`}>
        <div className="sectionHeader">
          <div>
            <h2>الأراضي والنباتات المتاحة</h2>
            <p>اختر الهدف قبل التحليل أو الري. النباتات الفردية تستخدم صورة محفوظة وحساس ESP32 فقط للرطوبة، ولا تعتمد على رطوبة Open-Meteo لأنها غالباً داخل المنازل أو المتاجر.</p>
          </div>
          <div className="actionsRow">
            <button className="secondary" onClick={() => loadLands(currentUser?.id)}>تحديث الأراضي</button>
            <button className="secondary" onClick={() => loadDeletedLands(currentUser?.id)}>تحديث المحذوفات</button>
            <button className="secondary" onClick={() => loadPottedPlants(currentUser?.id)}>تحديث النباتات</button>
          </div>
        </div>
        <div className="assetGrid">
          <article className="assetColumn">
            <div className="planHeader">
              <div>
                <span>Fields</span>
                <h3>الأراضي الزراعية</h3>
                <p>أهداف مرتبطة بالخريطة والطقس والأقمار الصناعية والري الحقلي.</p>
              </div>
              <strong>{lands.length}</strong>
            </div>
            <div className="assetList">
              {lands.length ? lands.map((land) => (
                <div className={`assetItem ${selectedLandId === String(land.id) && !selectedPottedPlantId ? "active" : ""}`} key={land.id}>
                  <div className="assetIdentity">
                    <div className="assetThumb fieldThumb">
                      {land.latest_image?.signed_url ? (
                        <img src={land.latest_image.signed_url} alt={`صورة ${land.name}`} />
                      ) : (
                        <span>GIS</span>
                      )}
                    </div>
                    <div>
                      <strong>{land.name}</strong>
                      <span>{land.crop_hint || "محصول غير محدد"} / {Number(land.area_m2 ?? 0).toFixed(0)} م2</span>
                      <small>{land.auto_irrigation_enabled ? "الري التلقائي مفعل" : "الري التلقائي غير مفعل"}</small>
                    </div>
                  </div>
                  <div className="assetActions">
                    <button className="miniButton" onClick={() => useLand(land)}>اختيار</button>
                    {isAdmin ? (
                      <button className="miniButton danger" onClick={() => deleteLand(Number(land.id))}>حذف</button>
                    ) : null}
                  </div>
                </div>
              )) : (
                <p className="mutedText">لا توجد أراض محفوظة بعد. ارسم أرض من الخريطة واحفظها.</p>
              )}
            </div>
          </article>
          {isAdmin ? (
            <article className="assetColumn deletedAssetsColumn">
              <div className="planHeader">
                <div>
                  <span>Archive</span>
                  <h3>محذوفات الأراضي</h3>
                  <p>أراض مؤرشفة فقط. أجهزة ESP32 وسجلات الحساسات تبقى محفوظة ويمكن استرجاع الأرض وربطها مجدداً.</p>
                </div>
                <strong>{deletedLands.length}</strong>
              </div>
              <div className="assetList">
                {deletedLands.length ? deletedLands.map((land) => (
                  <div className="assetItem archived" key={land.id}>
                    <div className="assetIdentity">
                      <div className="assetThumb fieldThumb">
                        {land.latest_image?.signed_url ? (
                          <img src={land.latest_image.signed_url} alt={`صورة ${land.name}`} />
                        ) : (
                          <span>OLD</span>
                        )}
                      </div>
                      <div>
                        <strong>{land.name}</strong>
                        <span>{land.crop_hint || "محصول غير محدد"} / {Number(land.area_m2 ?? 0).toFixed(0)} م2</span>
                        <small>
                          محذوفة مؤقتاً
                          {land.deleted_at ? ` / ${new Date(land.deleted_at).toLocaleString("ar-IQ")}` : ""}
                        </small>
                      </div>
                    </div>
                    <div className="assetActions">
                      <button className="miniButton" onClick={() => restoreLand(Number(land.id))}>استرجاع</button>
                    </div>
                  </div>
                )) : (
                  <p className="mutedText">لا توجد أراض في المحذوفات.</p>
                )}
              </div>
            </article>
          ) : null}
          <article className="assetColumn">
            <div className="planHeader">
              <div>
                <span>Indoor / Shop Plants</span>
                <h3>النباتات الفردية</h3>
                <p>أهداف محفوظة بالصورة. لا تستخدم رطوبة Open-Meteo، فقط قراءة حساس التربة إن كانت مربوطة بـ ESP32.</p>
              </div>
              <strong>{pottedPlants.length}</strong>
            </div>
            <div className="assetList">
              {pottedPlants.length ? pottedPlants.map((plant) => {
                const preview = (plant.command_preview ?? {}) as Partial<PottedPlantAnalysisResult["commandPreview"]>;
                const moisture = preview.soil_moisture_percent;
                return (
                  <div className={`assetItem ${selectedPottedPlantId === String(plant.id) ? "active" : ""}`} key={plant.id}>
                    <div className="assetIdentity">
                      <div className="assetThumb plantThumb">
                        {plant.signed_image_url ? (
                          <img src={plant.signed_image_url} alt={`صورة ${plant.name}`} />
                        ) : (
                          <span>IMG</span>
                        )}
                      </div>
                      <div>
                        <strong>{plant.name}</strong>
                        <span>{plant.location_label || "بدون مكان"} / {Number(preview.liters_target ?? 0).toFixed(2)} L</span>
                        <small>
                          {plant.linked_land_id ? `مرتبط بـ ${plant.lands?.name ?? `هدف #${plant.linked_land_id}`}` : "غير مربوط بحساس"}
                          {" / "}
                          رطوبة الحساس {moisture !== null && moisture !== undefined ? `${Number(moisture).toFixed(0)}%` : "غير متاحة"}
                        </small>
                      </div>
                    </div>
                    <div className="assetActions">
                      <button className="miniButton" onClick={() => usePottedPlant(plant)}>اختيار</button>
                      {isAdmin ? (
                        <button className="miniButton" onClick={() => reanalyzeSavedPottedPlant(String(plant.id))}>تحليل محفوظ</button>
                      ) : null}
                      {isAdmin ? (
                        <button className="miniButton danger" onClick={() => deletePottedPlant(plant.id)}>حذف</button>
                      ) : null}
                    </div>
                  </div>
                );
              }) : (
                <p className="mutedText">لا توجد نباتات فردية محفوظة بعد. ارفع صورة نبات مرة واحدة من صفحة البيانات وسيتم حفظها هنا.</p>
              )}
            </div>
          </article>
        </div>
      </section>

      <section className={`mapSection ${activeSection === "map" ? "" : "sectionHidden"}`}>
        <div className="sectionHeader">
          <div>
          <h2>تحديد الأرض</h2>
            <p>استخدم زر موقعي الآن عند الحاجة، وبدّل بين الطرق والأراضي الزراعية والقمر الصناعي لرسم حدود دقيقة.</p>
          </div>
          <div className="locationStack">
            <div className="placePill">
              <span>{placeLoading ? "جاري تحديد المكان..." : "الموقع الحالي"}</span>
              <strong>
                {place?.city || place?.district || "غير محدد"}
                {place?.governorate ? `، ${place.governorate}` : ""}
              </strong>
            </div>
            <div className="coordinatePill">
              {lat}, {lon}
            </div>
          </div>
        </div>
        <SatelliteLandMap
          center={mapCenter}
          polygon={polygonPoints}
          readOnly={!isAdmin}
          visible={activeSection === "map"}
          onPolygonChange={isAdmin ? updatePolygon : () => undefined}
          onCenterChange={updateMapCenter}
        />
        <div className="selectionSummary" aria-label="ملخص تحديد الأرض">
          <div>
            <span>المدينة والمحافظة</span>
            <strong>
              {place?.city || place?.district || "بانتظار الموقع"}
              {place?.governorate ? `، ${place.governorate}` : ""}
            </strong>
          </div>
          <div>
            <span>نقاط الحدود</span>
            <strong>{polygonPoints.length}</strong>
          </div>
          <div>
            <span>المساحة التقريبية</span>
            <strong>{Number(areaM2).toLocaleString("ar-IQ")} م2</strong>
          </div>
          <div>
            <span>الحفظ</span>
            <strong>{selectionReady ? "جاهز" : "يحتاج 3 نقاط"}</strong>
          </div>
        </div>
      </section>

      <section className={`workGrid ${activeSection === "field" ? "" : "sectionHidden"}`}>
        <div className="panel primaryPanel">
          <h2>بيانات الأرض</h2>
          {selectedLand ? (
            <p className="selectedLandNote">الأرض المختارة للتحليل: {selectedLand.name}</p>
          ) : null}
          <div className="fields">
            <label>
              أرض محفوظة
              <select value={selectedLandId} onChange={(event) => selectSavedLand(event.target.value)}>
                <option value="">استخدم الحدود الحالية</option>
                {lands.map((land) => (
                  <option key={land.id} value={land.id}>
                    {land.name} / {Number(land.area_m2).toFixed(0)} م2
                  </option>
                ))}
              </select>
            </label>
            <label>
              اسم الأرض
              <input value={landName} onChange={(event) => setLandName(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              المحصول المتوقع
              <input value={cropHint} onChange={(event) => setCropHint(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              المساحة المحسوبة م2
              <input value={areaM2} onChange={(event) => setAreaM2(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              تدفق الماء لتر/دقيقة
              <input value={flowRate} onChange={(event) => setFlowRate(event.target.value)} disabled={!isAdmin} />
              <span className="advancedPercentText">قدرة الماطور الحالية؛ تؤثر على زمن تشغيل الري ومؤشر الماء المصروف.</span>
            </label>
            <label>
              سعة الخزان لتر
              <input value={tankCapacityLiters} onChange={(event) => setTankCapacityLiters(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              الماء المتوفر الآن لتر
              <input value={tankCurrentLiters} onChange={(event) => setTankCurrentLiters(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              تعبئة الخزان اليومية / لتر
              <input value={tankDailyRefillLiters} onChange={(event) => setTankDailyRefillLiters(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              احتياطي لا يفرغ لتر
              <input value={tankReserveLiters} onChange={(event) => setTankReserveLiters(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              خطة توفير الماء %
              <span className="advancedPercentText">نسبة مخصصة احتياطية %</span>
              <input value={waterSavingPercent} onChange={(event) => setWaterSavingPercent(event.target.value)} disabled={!isAdmin} />
            </label>
            <label>
              مود الري
              <select value={irrigationMode} onChange={(event) => setIrrigationMode(event.target.value as IrrigationModeOption)} disabled={!isAdmin}>
                {IRRIGATION_MODE_OPTIONS.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="modePolicyBox">
            <span>{selectedIrrigationMode.shortLabel}</span>
            <strong>{selectedIrrigationMode.label}</strong>
            <p>{selectedIrrigationMode.description}</p>
            <small>يعتمد الحساب على FAO ETc/Kc وخصم المطر وحدود الخزان. هذه الكمية تمثل ماء السقي للوصول إلى هدف التشغيل، وليست كمية الامتصاص الفعلي داخل التربة.</small>
          </div>
          {isAdmin ? (
            <div className="tankSyncRow">
              <button className="secondary" onClick={syncTankFromEsp32}>سحب قراءة الخزان من ESP32</button>
              <span>{tankSyncSource ? `آخر قراءة: ${tankSyncSource}` : "إذا وصل ESP32 قراءة خزان، هذا الزر يحدث القيم تلقائياً."}</span>
            </div>
          ) : null}
          {isAdmin ? (
            <div className="actionsRow">
              <button onClick={saveLand}>{selectedLandId ? "تحديث الأرض المختارة" : "حفظ أرض جديدة"}</button>
              {selectedLandId ? (
                <button className="dangerButton" onClick={() => deleteLand(Number(selectedLandId))}>
                  حذف الأرض المختارة
                </button>
              ) : null}
              <button className="secondary" onClick={askAdvisor}>استشارة AI للأرض</button>
              <details className="technicalDetails">
                <summary>عرض GeoJSON</summary>
                <textarea
                  value={landGeojson}
                  onChange={(event) => setLandGeojson(event.target.value)}
                  placeholder="سيظهر GeoJSON تلقائياً بعد تحديد الحدود"
                />
              </details>
            </div>
          ) : (
            <p className="mutedText">هذه مساحة مشاهدة فقط. أي حفظ أو تعديل أو تشغيل يتم من حساب المدير.</p>
          )}
        </div>

        {isAdmin ? (
        <div className="panel">
          <h2>صور الهاتف أو الدرون</h2>
          <label>
            صورة حقيقية لزيادة دقة التحليل
            <input
              type="file"
              accept="image/*"
              onChange={(event) => setImage(event.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            Device UID للـ ESP32
            <input
              value={deviceUid}
              onChange={(event) => setDeviceUid(event.target.value)}
              placeholder="esp32-land-1-valve-1"
            />
          </label>
          <div className="manualPlantsPanel">
            <h3>جرد نباتات يدوي معتمد</h3>
            <p className="mutedText">استخدمه عندما تعرف العدد الحقيقي. هذا الرقم يصبح أوثق من عد الصور عند الجدولة والأسئلة.</p>
            <div className="fields">
              <label>
                نباتات شائعة في العراق
                <select value={selectedCropCatalogId} onChange={(event) => selectCropCatalogItem(event.target.value)}>
                  {cropCatalog.map((crop) => (
                    <option key={crop.id} value={crop.id}>
                      {crop.nameAr} / {crop.nameEn}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                اسم النبات
                <input value={manualPlantName} onChange={(event) => setManualPlantName(event.target.value)} placeholder="Date Palm" />
              </label>
              <label>
                العدد
                <input value={manualPlantCount} onChange={(event) => setManualPlantCount(event.target.value)} placeholder="4" />
              </label>
              <label>
                مرحلة النمو
                <select value={manualPlantStage} onChange={(event) => setManualPlantStage(event.target.value)}>
                  <option value="mature">ناضج</option>
                  <option value="fruiting">مثمر</option>
                  <option value="vegetative">نمو خضري</option>
                  <option value="seedling">بادرة</option>
                  <option value="unknown">غير محدد</option>
                </select>
              </label>
              <label>
                ملاحظة
                <input value={manualPlantNotes} onChange={(event) => setManualPlantNotes(event.target.value)} placeholder="تم التحقق ميدانياً" />
              </label>
            </div>
            {cropCatalog.find((crop) => crop.id === selectedCropCatalogId) ? (
              <div className="cropIrrigationInfo">
                {(() => {
                  const crop = cropCatalog.find((item) => item.id === selectedCropCatalogId)!;
                  return (
                    <>
                      <div><span>وحدة الحساب</span><strong>{crop.unit === "m2" ? "متر مربع" : crop.unit === "tree" ? "شجرة" : "نبات"}</strong></div>
                      <div><span>لتر/وحدة/رية</span><strong>{crop.litersPerUnitPerIrrigation}</strong></div>
                      <div><span>كل كم يوم</span><strong>{crop.intervalDays}</strong></div>
                      <div><span>نسبة السقاية</span><strong>{crop.wateringPercent}%</strong></div>
                      <div><span>مود الري المختار</span><strong>{selectedIrrigationMode.label}</strong></div>
                      <div>
                        <span>تطبيق المود</span>
                        <strong>
                          {Math.round(((crop.modeFactors?.[irrigationMode] ?? (irrigationMode === "survival" ? 0.35 : irrigationMode === "medium_productivity" ? 0.7 : 1)) * 100))}%
                        </strong>
                      </div>
                      <div><span>لتر يومي محسوب</span><strong>{Number(crop.dailyLitersPerUnit).toFixed(1)}</strong></div>
                      <div><span>ملاحظة موسمية</span><strong>{crop.season}</strong></div>
                      <div><span>طريقة الحساب</span><strong>{crop.method ?? "FAO mm/m2 + خزان محدود + خصم المطر"}</strong></div>
                      <div><span>المصدر</span><strong>{crop.source ?? "كتالوگ محلي"}</strong></div>
                    </>
                  );
                })()}
              </div>
            ) : null}
            <button className="secondary" onClick={addManualPlant} disabled={!selectedLandId}>إضافة للجرد اليدوي</button>
            {landOps?.recent.manualPlants?.length ? (
              <div className="manualPlantList">
                {landOps.recent.manualPlants.map((plant) => (
                  <div className="manualPlantItem" key={plant.id}>
                    <strong>{plant.name}</strong>
                    <span>{plant.count} / {translateGrowthStage(plant.growth_stage)}</span>
                    {plant.notes ? <small>{plant.notes}</small> : null}
                    <button className="miniButton danger" onClick={() => deleteManualPlant(plant.id)}>حذف</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mutedText">لا يوجد جرد يدوي محفوظ لهذه الأرض بعد.</p>
            )}
          </div>
          <div className="toolHubGrid">
            <article className="toolCard toolCardPrimary">
              <span>Image-only AI</span>
              <h3>تحليل نبات/أصيص بدون أرض</h3>
              <p>ارفع صورة واحدة، و Gemini يقدّر نوع النبات، حجم النبات، حجم الإناء والتربة، ثم يحسب رية أولية آمنة.</p>
              <label>
                اسم النبات للحفظ
                <input value={pottedPlantName} onChange={(event) => setPottedPlantName(event.target.value)} placeholder="مثال: نبات المتجر / شتلة النعناع" />
              </label>
              <label>
                مكان النبات
                <input value={pottedPlantLocation} onChange={(event) => setPottedPlantLocation(event.target.value)} placeholder="مثال: داخل البيت، قرب النافذة، محل تجاري" />
              </label>
              <label>
                ملاحظة اختيارية
                <input value={pottedPlantNotes} onChange={(event) => setPottedPlantNotes(event.target.value)} placeholder="مثال: أصيص داخلي، التربة جافة، بدون مسطرة" />
              </label>
              <small>إذا اخترت أرض/نبات مرتبط بـ ESP32 قبل التحليل، سيستخدم آخر رطوبة من الحساس فقط. لا يتم استخدام رطوبة Open-Meteo للنباتات الفردية.</small>
              <button onClick={analyzePottedPlantOnly} disabled={!image}>تحليل وحفظ النبات</button>
            </article>
            <article className="toolCard">
              <span>ESP32 Devices</span>
              <h3>الأجهزة الموجودة</h3>
              <p>اختر أي ESP32 متصل واربطه مباشرة بالأرض أو النبات الحالي. مناسب لعرض مؤقت بدون رفع firmware جديد.</p>
              <button className="secondary" onClick={loadIotDevices}>تحديث الأجهزة</button>
              <div className="manualPlantList">
                {iotDeviceInventory?.devices.length ? iotDeviceInventory.devices.slice(0, 5).map((device) => (
                  <div className="manualPlantItem" key={device.id}>
                    <strong>{device.device_uid}</strong>
                    <span>{device.connection_status === "online" ? "متصل" : "غير متصل"} / {device.land?.name ?? `أرض #${device.land_id}`}</span>
                    <small>
                      {device.latestTelemetry
                        ? `تدفق ${device.latestTelemetry.flow_liters_per_minute ?? "?"} L/min / صمام ${device.latestTelemetry.valve_state}`
                        : "لا توجد قراءة حساسات حديثة"}
                    </small>
                    <button className="miniButton" onClick={() => useIotDevice(device)}>
                      {selectedPottedPlantId ? "ربطه بالنبات" : selectedLandId ? "ربطه هنا" : "اختياره"}
                    </button>
                  </div>
                )) : (
                  <p className="mutedText">لا توجد أجهزة مسجلة بعد. شغل ESP32 أو اضغط تجهيز ESP32.</p>
                )}
              </div>
            </article>
          </div>
          {pottedPlantResult ? (
            <div className="agroInsightPanel">
              <div>
                <span>نتيجة صورة النبات فقط</span>
                <strong>
                  {pottedPlantResult.analysis.plant?.arabic_name || pottedPlantResult.analysis.plant?.name || "نبات غير محدد"}
                  {" / "}
                  {Number(pottedPlantResult.commandPreview.liters_target ?? 0).toFixed(2)} L
                </strong>
                <p>{pottedPlantResult.analysis.irrigation?.reason ?? "توصية مبنية على تقدير حجم الإناء والتربة من الصورة."}</p>
                <small>
                  مدة التشغيل المقترحة {pottedPlantResult.commandPreview.duration_seconds}s عند تدفق
                  {" "}{Number(pottedPlantResult.commandPreview.flow_rate_liters_per_minute ?? 0).toFixed(1)} L/min.
                  {pottedPlantResult.analysis.requires_human_review ? " تحتاج مراجعة بشرية لأن الثقة محدودة." : ""}
                </small>
                {pottedPlantResult.commandPreview.soil_moisture_percent !== null
                && pottedPlantResult.commandPreview.soil_moisture_percent !== undefined ? (
                  <small>
                    قراءة رطوبة التربة {Number(pottedPlantResult.commandPreview.soil_moisture_percent).toFixed(0)}%
                    {" "}عدلت التوصية من {Number(pottedPlantResult.commandPreview.raw_liters_target ?? pottedPlantResult.commandPreview.liters_target).toFixed(2)} L
                    {" "}إلى {Number(pottedPlantResult.commandPreview.liters_target ?? 0).toFixed(2)} L.
                  </small>
                ) : (
                  <small>لا توجد قراءة رطوبة مرتبطة بهذا التحليل، لذلك بقي القرار معتمداً على الصورة فقط.</small>
                )}
              </div>
              <div className="agroInsightMetrics">
                <div>
                  <span>حجم الإناء</span>
                  <strong>
                    {Number(pottedPlantResult.analysis.container?.estimated_volume_liters?.min ?? 0).toFixed(1)}
                    -
                    {Number(pottedPlantResult.analysis.container?.estimated_volume_liters?.max ?? 0).toFixed(1)} L
                  </strong>
                  <small>تقدير بصري، يتحسن إذا وضعت مسطرة أو جسم معروف الحجم بالصورة.</small>
                </div>
                <div>
                  <span>حجم التربة</span>
                  <strong>
                    {Number(pottedPlantResult.analysis.soil?.estimated_soil_volume_liters?.min ?? 0).toFixed(1)}
                    -
                    {Number(pottedPlantResult.analysis.soil?.estimated_soil_volume_liters?.max ?? 0).toFixed(1)} L
                  </strong>
                  <small>{pottedPlantResult.analysis.soil?.surface_condition ?? "unknown"}</small>
                </div>
                <div>
                  <span>حجم النبات</span>
                  <strong>
                    {Number(pottedPlantResult.analysis.plant?.estimated_height_cm?.min ?? 0).toFixed(0)}
                    -
                    {Number(pottedPlantResult.analysis.plant?.estimated_height_cm?.max ?? 0).toFixed(0)} cm
                  </strong>
                  <small>{translateGrowthStage(pottedPlantResult.analysis.plant?.growth_stage)}</small>
                </div>
                <div>
                  <span>نسبة الرية</span>
                  <strong>{Number(pottedPlantResult.commandPreview.watering_percent_of_soil_volume ?? 0).toFixed(1)}%</strong>
                  <small>من حجم التربة المقدر، وليست كمية امتصاص النبات.</small>
                </div>
                <div>
                  <span>تعديل الحساس</span>
                  <strong>{Number((pottedPlantResult.commandPreview.soil_moisture_adjustment_factor ?? 1) * 100).toFixed(0)}%</strong>
                  <small>عامل يقلل أو يوقف الري إذا كانت التربة رطبة فعلياً.</small>
                </div>
              </div>
              <div className="actionsRow">
                <button className="secondary" onClick={applyPottedPlantIrrigation}>نقلها للري اليدوي</button>
                {pottedPlantResult.saved?.pottedPlantId ? (
                  <button className="secondary" onClick={() => reanalyzeSavedPottedPlant(String(pottedPlantResult.saved?.pottedPlantId))}>
                    إعادة تحليل الصورة المحفوظة
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="actionsRow">
            <button className="secondary" onClick={generatePhotoMissionPlan}>خطة تصوير AI</button>
            <button className="secondary" onClick={registerEsp32Device} disabled={!selectedLandId}>تجهيز ESP32</button>
            <button onClick={analyze}>تحليل الصورة وحساب الري</button>
            <button className="secondary" onClick={analyzeSavedImagery} disabled={!selectedLandId}>
              تحليل الصور المحفوظة
            </button>
            <button className="secondary" onClick={() => sendIotCommand()} disabled={!result || !deviceUid}>
              إرسال أمر MQTT
            </button>
          </div>
          {deviceProvisioning ? (
            <div className="deviceProvisioningPanel">
              <div className="planHeader">
                <div>
                  <h3>تجهيز ESP32</h3>
                  <p>{deviceProvisioning.land.name} / {deviceProvisioning.device.device_uid}</p>
                  <p>{deviceProvisioning.mqttConfigured ? "MQTT مفعّل في إعدادات المنصة." : "MQTT غير مفعّل بعد في .env.local؛ التسجيل تم، لكن النشر يحتاج HiveMQ."}</p>
                </div>
                <div className="planDecision">
                  <span>Relay Pin</span>
                  <strong>{deviceProvisioning.device.relay_pin}</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>Command Topic</span>
                  <strong>{deviceProvisioning.topics.command}</strong>
                </div>
                <div>
                  <span>ACK Topic</span>
                  <strong>{deviceProvisioning.topics.ack}</strong>
                </div>
                <div>
                  <span>Telemetry</span>
                  <strong>{deviceProvisioning.topics.telemetryEndpoint}</strong>
                </div>
              </div>
              <pre>{deviceProvisioning.firmwareConfig}</pre>
              <button className="secondary" onClick={copyFirmwareConfig}>نسخ إعدادات firmware</button>
            </div>
          ) : null}
          {photoMission ? (
            <div className="photoMissionPanel">
              <div className="panelHeaderRow">
                <div>
                  <h3>{photoMission.mission.mission_title}</h3>
                  <p>{photoMission.mission.why_now}</p>
                </div>
                <span className={`riskBadge ${photoMission.mission.capture_priority}`}>
                  {photoMission.mission.capture_priority}
                </span>
              </div>
              <div className="missionShots">
                {photoMission.mission.shots.slice(0, 4).map((shot, index) => (
                  <div className="timelineItem" key={`${shot.title}-${index}`}>
                    <strong>{shot.title} / {shot.device}</strong>
                    <span>{shot.target}</span>
                    <small>{shot.distance} - {shot.angle} - {shot.success_criteria}</small>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>تركيز سوسة النخيل الحمراء</span>
                <strong>{photoMission.mission.red_palm_weevil_focus.join("، ")}</strong>
              </div>
              <div className="missionChecklist">
                <div>
                  <span>أقل صور مطلوبة</span>
                  <strong>{photoMission.mission.minimum_set_for_demo.join("، ")}</strong>
                </div>
                <div>
                  <span>بعد التصوير</span>
                  <strong>{photoMission.mission.after_capture_next_step}</strong>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        ) : (
        <div className="panel">
          <h2>حالة الأرض الزراعية</h2>
          {landOps ? (
            <div className="viewerSummary">
              <div className="viewerMetric">
                <span>قرار الحالة الحالي</span>
                <strong>{landOps.summary.operationalDecision}</strong>
              </div>
              <div className="viewerMetric">
                <span>آخر خطر آفات</span>
                <strong>{landOps.summary.latestPestRisk}</strong>
              </div>
              <div className="viewerMetric">
                <span>آخر كمية ري مقترحة</span>
                <strong>{Number(landOps.summary.latestRecommendedLiters).toFixed(1)} L</strong>
              </div>
              <div className="viewerMetric">
                <span>أجهزة فعالة</span>
                <strong>{landOps.summary.activeDevices}/{landOps.summary.devicesCount}</strong>
              </div>
              <div className="viewerMetric">
                <span>اتصال ESP32</span>
                <strong>
                  {landOps.summary.deviceConnectionStatus === "online"
                    ? "متصل الآن"
                    : landOps.summary.deviceConnectionStatus === "offline"
                      ? "غير متصل"
                      : "غير مسجل"}
                </strong>
              </div>
              <div className="viewerMetric">
                <span>صور وتحليلات محفوظة</span>
                <strong>{landOps.summary.imageryCount} صور / {landOps.summary.analysesCount} تحليلات</strong>
              </div>
              <div className="viewerMetric">
                <span>قراءات حساسات</span>
                <strong>{landOps.summary.telemetryCount}</strong>
              </div>
            </div>
          ) : selectedLandId ? (
            <p className="mutedText">جاري تحميل حالة الأرض المختارة...</p>
          ) : (
            <p className="mutedText">اختر أرضك المحفوظة حتى تظهر حالة النباتات والري والآفات.</p>
          )}
          {landOps?.recent.analyses.length ? (
            <div className="viewerBlock">
              <h3>ملخص مجمّع من صور الأرض</h3>
              {landOps.aggregate ? (
                <div className="analysisCard aggregateCard">
                  <div className="analysisCardHeader">
                    <strong>
                      {landOps.aggregate.source === "manual"
                        ? "جرد يدوي معتمد للنباتات"
                        : `تم تجميع ${landOps.aggregate.uniqueImages} صور فريدة`}
                    </strong>
                    <span>
                      {landOps.aggregate.source === "manual"
                        ? "مصدر موثوق من المدير"
                        : landOps.aggregate.duplicateImageRecords
                        ? `تم تجاهل ${landOps.aggregate.duplicateImageRecords} صور مكررة`
                        : "لا توجد صور مكررة"}
                    </span>
                  </div>
                  <div className="viewerSummary compact">
                    <div className="viewerMetric">
                      <span>النباتات بعد إزالة التكرار</span>
                      <strong>{landOps.aggregate.estimatedPlantsTotal}</strong>
                    </div>
                    <div className="viewerMetric">
                      <span>أنواع/مراحل نباتية</span>
                      <strong>{landOps.aggregate.uniquePlantGroups}</strong>
                    </div>
                    <div className="viewerMetric">
                      <span>أعلى خطر آفات</span>
                      <strong>{translateRiskLevel(landOps.aggregate.pest.highestRisk)}</strong>
                    </div>
                  </div>
                  <div className="plantChips">
                    {landOps.aggregate.plants.length ? landOps.aggregate.plants.map((plant) => (
                      <div className="plantChip" key={`${plant.name}-${plant.stages.join("-")}`}>
                        <strong>{plant.name}</strong>
                        <span>العدد التقديري بدون تكرار واضح: {plant.estimatedCount}</span>
                        <span>{plant.source === "manual" ? "مدخل يدوياً" : `شوهد في ${plant.sightings} تحليل`}</span>
                        <span>المراحل: {plant.stages.map(translateGrowthStage).join("، ")}</span>
                        <span>متوسط الثقة: {Math.round(Number(plant.averageConfidence ?? 0) * 100)}%</span>
                        {plant.notes ? <small>{plant.notes}</small> : null}
                      </div>
                    )) : (
                      <p className="mutedText">لم يتم رصد نباتات واضحة من الصور المرفوعة.</p>
                    )}
                  </div>
                  <div className={`pestStatus ${landOps.aggregate.pest.redPalmWeevilDetected ? "warning" : "clear"}`}>
                    <strong>
                      {landOps.aggregate.pest.redPalmWeevilDetected
                        ? "توجد مؤشرات سوسة نخيل في بعض الصور"
                        : "لا توجد مؤشرات واضحة لسوسة النخيل الحمراء"}
                    </strong>
                    <span>عدد مرات ظهور مؤشر السوسة: {landOps.aggregate.pest.redPalmWeevilSightings}</span>
                  </div>
                </div>
              ) : null}

              <h3>آخر التحليلات كدليل</h3>
              {landOps.recent.analyses.slice(0, 2).map((analysis) => {
                const plants = plantRows(analysis.plant_summary);
                const pests = pestView(analysis.pest_summary);

                return (
                  <div className="analysisCard" key={analysis.id}>
                    <div className="analysisCardHeader">
                      <strong>تحليل #{analysis.id}</strong>
                      <span>ثقة عامة {Math.round(Number(analysis.confidence ?? 0) * 100)}%</span>
                    </div>
                    <div className="plantChips">
                      {plants.length ? plants.map((plant, index) => (
                        <div className="plantChip" key={`${analysis.id}-${plant.name}-${index}`}>
                          <strong>{plant.name}</strong>
                          <span>العدد: {plant.count || "غير مؤكد"}</span>
                          <span>المرحلة: {plant.stage}</span>
                          <span>ثقة العد: {Math.round(plant.confidence * 100)}%</span>
                          {plant.notes ? <small>{plant.notes}</small> : null}
                        </div>
                      )) : (
                        <p className="mutedText">لم يتم رصد نباتات واضحة في هذا التحليل.</p>
                      )}
                    </div>
                    <div className={`pestStatus ${pests.detected ? "warning" : "clear"}`}>
                      <strong>{pests.detected ? "توجد مؤشرات آفات تحتاج متابعة" : "لا توجد مؤشرات آفات واضحة"}</strong>
                      <span>مستوى الخطر: {pests.risk}</span>
                      <span>
                        سوسة النخيل الحمراء: {pests.redPalmWeevilDetected ? "مؤشرات موجودة" : "لا توجد مؤشرات واضحة"}
                        {" / "}
                        ثقة {Math.round(pests.redPalmWeevilConfidence * 100)}%
                      </span>
                      {pests.suspectedNames.length ? <small>آفات مشتبه بها: {pests.suspectedNames.join("، ")}</small> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        )}
      </section>

      <section className={`fieldTriage ${activeSection === "field" && isAdmin ? "" : "sectionHidden"}`}>
        <div className="boardHeader">
          <div>
            <h2>تشخيص ملاحظة ميدانية بالذكاء الاصطناعي</h2>
            <p>اكتب ما شاهده المزارع في الأرض، وسيحوّله AI إلى احتمالات وفحوصات وإجراءات عملية.</p>
          </div>
          <button onClick={triageNote}>تشخيص الملاحظة</button>
        </div>
        <textarea
          value={fieldNote}
          onChange={(event) => setFieldNote(event.target.value)}
          placeholder="مثال: لاحظت اصفرار في أطراف السعف وذبول خفيف، ولا توجد أمطار منذ أيام..."
        />
        {fieldTriage ? (
          <div className="triageResult">
            <div className="opsDecision">
              <span>ملخص التشخيص</span>
              <strong>{fieldTriage.triage.triage_summary}</strong>
            </div>
            <div className="triageGrid">
              <div>
                <h3>الأسباب المحتملة</h3>
                {fieldTriage.triage.likely_causes.map((cause, index) => (
                  <div className="timelineItem" key={`${cause.cause}-${index}`}>
                    <strong>{cause.cause} / {Number(cause.confidence).toFixed(2)}</strong>
                    <span>{cause.why}</span>
                  </div>
                ))}
              </div>
              <div>
                <h3>إجراءات فورية</h3>
                {fieldTriage.triage.immediate_actions.map((action, index) => (
                  <div className="timelineItem" key={`${action.title}-${index}`}>
                    <strong>{action.title} / {action.priority}</strong>
                    <span>{action.how_to_do_it}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="pitchBox">
              <span>تعديل الري</span>
              <strong>{fieldTriage.triage.irrigation_adjustment.recommendation}</strong>
            </div>
          </div>
        ) : null}
      </section>

      {dashboard && activeSection === "admin" && currentProfile?.role === "admin" ? (
        <section className="managerBoard">
          <div className="boardHeader">
            <div>
              <h2>لوحة Admin</h2>
              <p>مؤشرات تشغيلية حقيقية من Supabase لإدارة الأراضي والأجهزة والقرارات.</p>
            </div>
            <div className="actionsRow">
              <button className="secondary" onClick={loadDashboard}>تحديث المؤشرات</button>
              <button className="secondary" onClick={generateDailyOpsBrief}>موجز اليوم AI</button>
              <button className="secondary" onClick={generatePortfolioPriorityPlan}>أولويات الأراضي AI</button>
              <button className="secondary" onClick={generateWaterBudgetPlan}>{selectedPottedPlant ? "حساب ري النبات" : "ميزانية الماء"}</button>
            </div>
          </div>
          <div className="managerMetrics">
            <div><span>الأراضي</span><strong>{dashboard.totals.lands}</strong></div>
            <div><span>المساحة الكلية</span><strong>{dashboard.totals.areaM2.toLocaleString("ar-IQ")} م2</strong></div>
            <div><span>تحليلات AI</span><strong>{dashboard.totals.analyses}</strong></div>
            <div><span>توصيات الري</span><strong>{dashboard.totals.recommendations}</strong></div>
            <div><span>مخاطر آفات</span><strong>{dashboard.totals.highRiskAnalyses}</strong></div>
            <div><span>آخر ري مقترح</span><strong>{Number(dashboard.totals.latestRecommendedLiters).toFixed(1)} L</strong></div>
          </div>
          <div className="adminControlGrid">
            <div className="adminPanel">
              <div className="panelHeaderRow">
                <h3>إضافة مستخدم</h3>
                <button className="miniButton" onClick={loadAdminUsers}>تحديث</button>
              </div>
              <label>
                الاسم
                <input value={newUserName} onChange={(event) => setNewUserName(event.target.value)} placeholder="اسم المستخدم" />
              </label>
              <label>
                البريد الإلكتروني
                <input value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="farmer@example.com" />
              </label>
              <label>
                كلمة المرور المؤقتة
                <input type="password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="6 أحرف على الأقل" />
              </label>
              <label>
                الصلاحية
                <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as "farmer" | "admin" | "operator")}>
                  <option value="farmer">مستخدم أرض</option>
                  <option value="operator">مشغل</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <button onClick={createManagedUser}>إنشاء المستخدم</button>
            </div>

            <div className="adminPanel">
              <h3>ربط مستخدم بقطعة أرض</h3>
              <label>
                المستخدم
                <select value={selectedAdminUserId} onChange={(event) => setSelectedAdminUserId(event.target.value)}>
                  <option value="">اختر مستخدم</option>
                  {adminUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.full_name ?? user.email} / {user.role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                الأرض
                <select value={selectedAdminLandId} onChange={(event) => setSelectedAdminLandId(event.target.value)}>
                  <option value="">اختر أرض</option>
                  {lands.map((land) => (
                    <option key={land.id} value={land.id}>
                      {land.name} / {Number(land.area_m2).toFixed(1)} م2
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={assignLandToUser} disabled={!selectedAdminUserId || !selectedAdminLandId}>
                ربط الأرض
              </button>
            </div>

            <div className="adminPanel">
              <div className="panelHeaderRow">
                <h3>إضافة ESP32 وملحقاته</h3>
                <button className="miniButton" onClick={loadIotDevices}>تحديث</button>
              </div>
              <label>
                الأرض الأولية
                <select value={adminEspLandId} onChange={(event) => setAdminEspLandId(event.target.value)}>
                  <option value="">اختر أرض أو استخدم الأرض النشطة</option>
                  {lands.map((land) => (
                    <option key={land.id} value={land.id}>
                      {land.name} / {land.crop_hint ?? "بدون محصول"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Device UID
                <input value={adminEspDeviceUid} onChange={(event) => setAdminEspDeviceUid(event.target.value)} placeholder="esp32-land-2-demo-valve" />
              </label>
              <div className="compactFields">
                <label>
                  Relay GPIO
                  <input value={adminEspRelayPin} onChange={(event) => setAdminEspRelayPin(event.target.value)} />
                </label>
                <label>
                  تدفق المضخة L/min
                  <input value={adminEspPumpFlow} onChange={(event) => setAdminEspPumpFlow(event.target.value)} />
                </label>
              </div>
              <div className="compactFields">
                <label>
                  حساس التربة
                  <input value={adminEspSoilSensorModel} onChange={(event) => setAdminEspSoilSensorModel(event.target.value)} />
                </label>
                <label>
                  حساس الخزان
                  <input value={adminEspTankSensorModel} onChange={(event) => setAdminEspTankSensorModel(event.target.value)} />
                </label>
              </div>
              <div className="compactFields">
                <label>
                  الريلاي
                  <input value={adminEspRelayModel} onChange={(event) => setAdminEspRelayModel(event.target.value)} />
                </label>
                <label>
                  المضخة
                  <input value={adminEspPumpModel} onChange={(event) => setAdminEspPumpModel(event.target.value)} />
                </label>
              </div>
              <div className="toggleGrid">
                <label><input type="checkbox" checked={adminEspHasSoilSensor} onChange={(event) => setAdminEspHasSoilSensor(event.target.checked)} /> رطوبة تربة</label>
                <label><input type="checkbox" checked={adminEspHasTankSensor} onChange={(event) => setAdminEspHasTankSensor(event.target.checked)} /> مستوى خزان</label>
                <label><input type="checkbox" checked={adminEspHasRelay} onChange={(event) => setAdminEspHasRelay(event.target.checked)} /> Relay</label>
                <label><input type="checkbox" checked={adminEspHasPump} onChange={(event) => setAdminEspHasPump(event.target.checked)} /> مضخة</label>
                <label><input type="checkbox" checked={adminEspHasFlowMeter} onChange={(event) => setAdminEspHasFlowMeter(event.target.checked)} /> حساس تدفق</label>
              </div>
              <label>
                ملاحظات القطعة
                <input value={adminEspNotes} onChange={(event) => setAdminEspNotes(event.target.value)} placeholder="مثال: مركبة على مجسم العرض / مضخة USB صغيرة" />
              </label>
              <button onClick={createAdminEspDevice}>حفظ ESP32</button>
              <small>إذا كانت القطعة مبرمجة وتبث telemetry، ستظهر حالتها هنا ويمكن نقلها لأي أرض.</small>
            </div>

            <div className="adminPanel adminUsersPanel">
              <h3>أجهزة ESP32 وربطها بالأراضي</h3>
              <label>
                ربط الجهاز المختار بأرض
                <select value={adminEspBindLandId} onChange={(event) => setAdminEspBindLandId(event.target.value)}>
                  <option value="">اختر الأرض الجديدة</option>
                  {lands.map((land) => (
                    <option key={land.id} value={land.id}>
                      {land.name} / {land.crop_hint ?? "بدون محصول"}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={bindAdminEspDevice} disabled={!adminEspDeviceUid || !adminEspBindLandId}>
                ربط ESP32 بالأرض المختارة
              </button>
              <div className="adminUserList">
                {iotDeviceInventory?.devices.length ? iotDeviceInventory.devices.map((device) => (
                  <div className="adminUserItem" key={device.id}>
                    <strong>{device.device_uid}</strong>
                    <span>{device.connection_status === "online" ? "متصل" : "غير متصل"} / {device.land?.name ?? `أرض #${device.land_id}`}</span>
                    <small>
                      Relay GPIO {device.relay_pin}
                      {" / "}
                      Flow {Number(device.latestTelemetry?.flow_liters_per_minute ?? device.pump_flow_liters_per_minute ?? 0).toFixed(1)} L/min
                    </small>
                    <small>
                      Soil {device.soil_sensor_model ?? "HW-030"}
                      {" / Tank "}
                      {device.tank_sensor_model ?? "HW-038"}
                      {" / Pump "}
                      {device.pump_model ?? "غير محدد"}
                    </small>
                    <div className="actionsRow">
                      <button
                        className="miniButton"
                        onClick={() => {
                          setAdminEspDeviceUid(device.device_uid);
                          setDeviceUid(device.device_uid);
                          setAdminEspBindLandId(String(device.land_id));
                          setAdminEspRelayPin(String(device.relay_pin ?? 26));
                          if (device.latestTelemetry?.flow_liters_per_minute || device.pump_flow_liters_per_minute) {
                            setAdminEspPumpFlow(String(device.latestTelemetry?.flow_liters_per_minute ?? device.pump_flow_liters_per_minute));
                          }
                        }}
                      >
                        اختيار
                      </button>
                      <button
                        className="miniButton"
                        onClick={() => {
                          setAdminEspDeviceUid(device.device_uid);
                          setDeviceUid(device.device_uid);
                          setAdminEspBindLandId(selectedLandId || String(device.land_id));
                        }}
                      >
                        جهزه للربط
                      </button>
                    </div>
                  </div>
                )) : (
                  <p className="mutedText">لا توجد أجهزة بعد. أضف ESP32 من النموذج أو شغّل القطعة حتى ترسل telemetry.</p>
                )}
              </div>
            </div>

            <div className="adminPanel adminUsersPanel">
              <h3>المستخدمون والصلاحيات</h3>
              {adminUsers.length ? (
                <div className="adminUserList">
                  {adminUsers.map((user) => (
                    <div className="adminUserItem" key={user.id}>
                      <strong>{user.full_name ?? user.email}</strong>
                      <span>{user.email} / {user.role}</span>
                      {(user.land_memberships ?? []).length ? (
                        <div className="membershipList">
                          {(user.land_memberships ?? []).map((item) => (
                            <div className="membershipItem" key={item.id}>
                              <small>{item.lands?.name ?? `Land ${item.land_id}`}</small>
                              <button className="miniButton danger" onClick={() => unlinkLandAccess(item.id)}>فك الربط</button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <small>غير مربوط بأرض</small>
                      )}
                      <button
                        className="miniButton danger"
                        onClick={() => deleteManagedUser(user.id)}
                        disabled={user.id === currentUser.id}
                      >
                        حذف المستخدم
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mutedText">لا يوجد مستخدمون بعد أو لم يتم تحميل القائمة.</p>
              )}
            </div>
          </div>
          {demoRunbook ? (
            <div className="demoRunbookPanel">
              <div className="planHeader">
                <div>
                  <h3>{demoRunbook.runbook.title}</h3>
                  <p>{demoRunbook.runbook.opening_line}</p>
                  <p>مصدر الخطة: {demoRunbook.source === "gemini" ? "Gemini مع تدوير المفاتيح" : "قواعد المنصة عند ضغط Gemini"}</p>
                </div>
                <div className="planDecision">
                  <span>دليل حي</span>
                  <strong>{Object.values(demoRunbook.metrics).reduce((sum, value) => sum + Number(value ?? 0), 0)}</strong>
                </div>
              </div>
              <div className="runbookSteps">
                {demoRunbook.runbook.demo_steps.map((step) => (
                  <div className="timelineItem" key={`${step.step}-${step.screen}`}>
                    <strong>{step.step}. {step.screen}: {step.action}</strong>
                    <span>{step.talk_track}</span>
                    <span>{step.evidence_to_show}</span>
                    <small>{step.judge_should_notice}</small>
                  </div>
                ))}
              </div>
              <div className="briefGrid">
                <div>
                  <h4>إذا ضغط Gemini أثناء العرض</h4>
                  {demoRunbook.runbook.fallback_if_live_ai_quota_fails.map((item, index) => (
                    <div className="timelineItem" key={`${item}-${index}`}>
                      <strong>{item}</strong>
                    </div>
                  ))}
                </div>
                <div>
                  <h4>فجوات نذكرها بصدق</h4>
                  {(demoRunbook.runbook.honest_gaps.length ? demoRunbook.runbook.honest_gaps : ["لا توجد فجوات حرجة في بيانات runbook الحالية."]).map((gap, index) => (
                    <div className="timelineItem" key={`${gap}-${index}`}>
                      <strong>{gap}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="pitchBox">
                <span>خاتمة العرض</span>
                <strong>{demoRunbook.runbook.closing_line}</strong>
              </div>
            </div>
          ) : null}
          {waterBudget ? (
            <div className="waterBudgetPanel">
              <div className="planHeader">
                <div>
                  <h3>ميزانية الماء للمحفظة</h3>
                  <p>توزيع الخزان الحالي على الأراضي حسب احتياج النباتات، المطر المتوقع، جاهزية الجهاز، والنواقص التشغيلية.</p>
                </div>
                <div className="planDecision">
                  <span>نقص إجمالي</span>
                  <strong>{Number(waterBudget.summary.total_shortage_liters ?? 0).toFixed(1)} L</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div><span>الأراضي</span><strong>{waterBudget.summary.lands}</strong></div>
                <div><span>المطلوب</span><strong>{Number(waterBudget.summary.total_required_liters ?? 0).toFixed(1)} L</strong></div>
                <div><span>القابل للتنفيذ</span><strong>{Number(waterBudget.summary.total_executable_liters ?? 0).toFixed(1)} L</strong></div>
                <div><span>المتبقي بالخزان</span><strong>{Number(waterBudget.tank.remaining_after_plan_liters ?? 0).toFixed(1)} L</strong></div>
                <div><span>أراض جاهزة</span><strong>{waterBudget.summary.ready_lands}</strong></div>
                <div><span>مصدر الخزان</span><strong>{waterBudget.tank.source === "iot_telemetry" ? "ESP32" : "يدوي"}</strong></div>
                <div><span>مود الري</span><strong>{irrigationModeLabel(waterBudget.water_policy?.irrigation_mode ?? irrigationMode)}</strong></div>
                <div><span>نسبة تطبيق المود</span><strong>{Number(waterBudget.water_policy?.water_saving_percent ?? demoSavingPercent).toFixed(0)}%</strong></div>
              </div>
              {waterBudget.tank.source === "iot_telemetry" ? (
                <div className="pitchBox">
                  <span>آخر قراءة خزان</span>
                  <strong>
                    {Number(waterBudget.tank.available_liters ?? 0).toFixed(1)} L
                    {waterBudget.tank.level_percent !== null && waterBudget.tank.level_percent !== undefined
                      ? ` / ${Number(waterBudget.tank.level_percent).toFixed(0)}%`
                      : ""}
                    {waterBudget.tank.device_uid ? ` / ${waterBudget.tank.device_uid}` : ""}
                  </strong>
                </div>
              ) : null}
              <div className="demoFlow">
                {waterBudget.dispatch_order.slice(0, 6).map((item) => (
                  <div className="timelineItem" key={`water-dispatch-${item.rank}-${item.land_id}`}>
                    <strong>#{item.rank} {item.land_name} / {item.decision}</strong>
                    <span>تخصيص {Number(item.allocated_liters ?? 0).toFixed(1)} L / غير مغطى {Number(item.unmet_liters ?? 0).toFixed(1)} L</span>
                    <span>دفعة آمنة {Number(item.safe_batch_liters ?? 0).toFixed(1)} L / {Number(item.safe_batch_duration_seconds ?? 0).toFixed(0)}s</span>
                    <small>{item.reason}</small>
                    <button
                      className="miniButton"
                      onClick={() => approveWaterBudgetDispatch(item)}
                      disabled={
                        !item.device_uid
                        || Number(item.safe_batch_liters ?? 0) <= 0
                        || Number(item.safe_batch_duration_seconds ?? 0) <= 0
                        || Number(item.safe_batch_duration_seconds ?? 0) > 1800
                      }
                    >
                      اعتماد دفعة الميزانية
                    </button>
                  </div>
                ))}
              </div>
              <div className="briefGrid">
                {waterBudget.allocations.slice(0, 4).map((item) => (
                  <div className="timelineItem" key={`water-allocation-${item.land_id}`}>
                    <strong>{item.land_name} / {item.decision}</strong>
                    <span>{Number(item.required_liters ?? 0).toFixed(1)} L كل {Number(item.interval_days ?? 1).toFixed(0)} يوم</span>
                    <span>{irrigationModeLabel(item.irrigation_mode ?? irrigationMode)} / {Number(item.water_saving_percent ?? 0).toFixed(0)}%</span>
                    {item.agronomic_adjustment ? (
                      <span>
                        زراعي: ×{Number(item.agronomic_adjustment.factor ?? 1).toFixed(2)}
                        {item.agronomic_adjustment.openMeteo
                          ? ` / ET0 ${Number(item.agronomic_adjustment.openMeteo.et0DailyAverageMm ?? 0).toFixed(1)} mm/day`
                          : ""}
                      </span>
                    ) : null}
                    {item.agronomic_adjustment?.soilGrids ? (
                      <span>
                        تربة: {item.agronomic_adjustment.soilGrids.textureClass ?? "غير متاحة"}
                        {item.agronomic_adjustment.soilGrids.sandPercent !== null
                          ? ` / رمل ${Number(item.agronomic_adjustment.soilGrids.sandPercent).toFixed(0)}%`
                          : ""}
                      </span>
                    ) : null}
                    <span>ESP32: {item.device_uid ?? "غير مربوط"} / آفات: {item.pest_risk}</span>
                    {item.agronomic_adjustment?.reasons?.length ? <small>{item.agronomic_adjustment.reasons[0]}</small> : null}
                    {item.missing.length ? <small>{item.missing.join(" / ")}</small> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {portfolioPriority ? (
            <div className="portfolioPriority">
              <div className="planHeader">
                <div>
                  <h3>{portfolioPriority.priority.headline}</h3>
                  <p>{portfolioPriority.priority.manager_summary}</p>
                  {portfolioPriority.prioritySource ? (
                    <p>مصدر القرار: {portfolioPriority.prioritySource === "gemini" ? "Gemini" : "ترتيب تشغيلي من البيانات عند نفاد حصة Gemini"}</p>
                  ) : null}
                </div>
                <div className="planDecision">
                  <span>خطر المحفظة</span>
                  <strong>{portfolioPriority.priority.portfolio_risk}</strong>
                </div>
              </div>
              <div className="demoFlow">
                {portfolioPriority.priority.ranked_lands.map((land) => (
                  <div className="timelineItem" key={`${land.rank}-${land.land_id}`}>
                    <strong>#{land.rank} {land.land_name} / {land.priority}</strong>
                    <span>{land.primary_reason}</span>
                    <span>{land.recommended_action} / {land.evidence.join(" / ")}</span>
                    {land.missing_data.length ? <small>{land.missing_data.join(" / ")}</small> : null}
                  </div>
                ))}
              </div>
              <div className="demoFlow">
                {portfolioPriority.priority.dispatch_plan.map((task, index) => (
                  <div className="timelineItem" key={`${task.owner}-${index}`}>
                    <strong>{task.owner}: {task.task}</strong>
                    <span>{task.target_land} / {task.time_window}</span>
                    <span>{task.success_metric}</span>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>قيمة تشغيلية للإدارة</span>
                <strong>{portfolioPriority.priority.manager_summary}</strong>
              </div>
              {portfolioPriority.priority.system_gaps.length ? (
                <div className="pitchBox">
                  <span>فجوات النظام</span>
                  <strong>{portfolioPriority.priority.system_gaps.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {readiness ? (
            <div className="readinessPanel">
              <div className="planHeader">
                <div>
                  <h3>{readiness.readiness.headline}</h3>
                  <p>{readiness.readiness.judge_story}</p>
                </div>
                <div className="planDecision">
                  <span>{readiness.readiness.readiness_label}</span>
                  <strong>{Number(readiness.readiness.readiness_score).toFixed(0)}/100</strong>
                </div>
              </div>
              <div className="demoFlow">
                {readiness.readiness.critical_gaps.map((gap, index) => (
                  <div className="timelineItem" key={`${gap.gap}-${index}`}>
                    <strong>{gap.gap} / {gap.priority}</strong>
                    <span>{gap.why_it_matters}</span>
                    <span>{gap.fix}</span>
                  </div>
                ))}
              </div>
              <div className="demoFlow">
                {readiness.readiness.next_72_hours.map((task, index) => (
                  <div className="timelineItem" key={`${task.task}-${index}`}>
                    <strong>{task.owner}: {task.task}</strong>
                    <span>{task.success_evidence}</span>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>مسار عرض مقترح</span>
                <strong>{readiness.readiness.demo_flow.join(" / ")}</strong>
              </div>
            </div>
          ) : null}
          {dailyBrief ? (
            <div className="dailyBrief">
              <h3>{dailyBrief.brief.brief_title}</h3>
              <p className="pitchLead">{dailyBrief.brief.today_summary}</p>
              <div className="briefGrid">
                <div>
                  <h4>أولويات اليوم</h4>
                  {dailyBrief.brief.top_priorities.map((item, index) => (
                    <div className="timelineItem" key={`${item.priority}-${index}`}>
                      <strong>{item.priority} / {item.owner} / {item.urgency}</strong>
                      <span>{item.why_now}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <h4>أراض تحتاج متابعة</h4>
                  {dailyBrief.brief.lands_to_watch.map((land, index) => (
                    <div className="timelineItem" key={`${land.land_name}-${index}`}>
                      <strong>{land.land_name}</strong>
                      <span>{land.reason} / {land.recommended_next_step}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="pitchBox">
                <span>قيمة التشغيل اليوم</span>
                <strong>{dailyBrief.brief.demo_value}</strong>
              </div>
            </div>
          ) : null}
          <div className="roiPanel">
            <div className="boardHeader">
              <div>
                <h3>حاسبة أثر المنصة</h3>
                <p>حوّل قرارات الري والتحليل إلى قيمة مائية وتشغيلية قابلة للشرح.</p>
              </div>
              <button onClick={calculateRoi}>حساب الأثر AI</button>
            </div>
            <div className="fields">
              <label>
                كلفة اللتر
                <input value={waterCostPerLiter} onChange={(event) => setWaterCostPerLiter(event.target.value)} />
              </label>
              <label>
                كلفة الزيارة/الفحص
                <input value={laborCostPerInspection} onChange={(event) => setLaborCostPerInspection(event.target.value)} />
              </label>
              <label>
                زيارات تم تجنبها
                <input value={avoidedInspections} onChange={(event) => setAvoidedInspections(event.target.value)} />
              </label>
            </div>
            {roi ? (
              <div className="roiResult">
                <div className="managerMetrics">
                  <div><span>ماء موفر مقاس</span><strong>{Number(roi.metrics.measuredWaterSavingLiters).toFixed(1)} L</strong></div>
                  <div><span>قيمة ماء تقديرية</span><strong>{Number(roi.metrics.estimatedWaterSavingValue).toFixed(2)}</strong></div>
                  <div><span>قيمة تشغيل تقديرية</span><strong>{Number(roi.metrics.estimatedLaborSavingValue).toFixed(2)}</strong></div>
                  <div><span>إجمالي أثر تقديري</span><strong>{Number(roi.metrics.estimatedTotalValue).toFixed(2)}</strong></div>
                </div>
                <div className="pitchBox">
                  <span>{roi.narrative.roi_headline}</span>
                  <strong>{roi.narrative.judge_value}</strong>
                </div>
              </div>
            ) : null}
          </div>
          {judgeReport ? (
            <div className="judgeReport">
              <h3>{judgeReport.report.headline}</h3>
              <p className="pitchLead">{judgeReport.report.one_minute_pitch}</p>
              <div className="reportColumns">
                <div>
                  <span>المشكلة</span>
                  <strong>{judgeReport.report.problem}</strong>
                </div>
                <div>
                  <span>الحل</span>
                  <strong>{judgeReport.report.solution}</strong>
                </div>
                <div>
                  <span>زاوية الفوز</span>
                  <strong>{judgeReport.report.winning_angle}</strong>
                </div>
              </div>
              <div className="demoFlow">
                {judgeReport.report.demo_flow.map((step, index) => (
                  <div className="timelineItem" key={`${step.step}-${index}`}>
                    <strong>{step.step}</strong>
                    <span>{step.what_judges_should_notice}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {legacyDemoVisible && activeSection === "demo" && currentProfile?.role === "admin" ? (
        <section className="readyDemo">
          <div className="readyDemoHero">
            <div>
              <span>سيناريو تشغيل كامل</span>
              <h2>شلون تكون المنصة إذا كل شيء جاهز ومربوط</h2>
              <p>
                هذا العرض يشرح التدفق المثالي داخل النظام: أرض مرسومة، مستخدم مربوط، صور محفوظة،
                تحليل AI، جدول ري ذكي، ESP32 متصل، وقرار تشغيل قابل للتدقيق.
              </p>
            </div>
            <div className="readyDemoBadge">
              <span>حالة السيناريو</span>
              <strong>Ready Demo</strong>
              <small>لا يرسل MQTT فعلياً من هذه الشاشة</small>
            </div>
          </div>

          <div className="smartDemoSummary">
            <div>
              <span>جاهزية ذكية</span>
              <strong>{smartDemoSummary.readinessScore}/100</strong>
              <small>{smartDemoSummary.readinessLabel}</small>
            </div>
            <div>
              <span>الرية / الدفعة</span>
              <strong>{Number(smartDemoSummary.waterTarget ?? 0).toFixed(1)} L</strong>
              <small>دفعة آمنة {Number(smartDemoSummary.safeBatch ?? 0).toFixed(1)} L</small>
            </div>
            <div>
              <span>الخزان المتاح</span>
              <strong>{Number(smartDemoSummary.tankUsable ?? 0).toFixed(1)} L</strong>
              <small>نقص {Number(smartDemoSummary.tankShortage ?? 0).toFixed(1)} L</small>
            </div>
            <div>
              <span>الأجهزة والأوامر</span>
              <strong>{smartDemoSummary.activeDevices} ESP32</strong>
              <small>{smartDemoSummary.commands} أوامر / {smartDemoSummary.latestCommandStatus}</small>
            </div>
            <div>
              <span>تنفيذ تلقائي</span>
              <strong>{smartDemoSummary.autoExecuted}</strong>
              <small>أوامر نشرها Autopilot الآمن</small>
            </div>
            <div className="summaryWide">
              <span>أكبر مانع الآن</span>
              <strong>{smartDemoSummary.biggestBlocker}</strong>
            </div>
          </div>

          <div className="agentModeStrip">
            <div>
              <span>Agent Mode</span>
              <strong>مراقبة وتشغيل</strong>
              <small>يفحص الأراضي، الخزان، الطقس، ESP32، والآفات قبل أي أمر.</small>
            </div>
            <div>
              <span>Autopilot Cron</span>
              <strong>جاهز للجدولة</strong>
              <small>المسار المحمي يعمل بتوكن ولا ينفذ تلقائياً بدون قراءة خزان.</small>
            </div>
            <div>
              <span>Safety Gate</span>
              <strong>Admin Approval</strong>
              <small>المستخدم يشاهد الحالة فقط، والاعتماد يبقى من صلاحيات الأدمن.</small>
            </div>
          </div>

          <div className="agentDecisionBoard">
            <div className="planHeader">
              <div>
                <h3>لوحة قرار الوكيل</h3>
                <p>{agentDecisionFlow.summary}</p>
              </div>
              <div className="planDecision">
                <span>{agentDecisionFlow.status}</span>
                <strong>{agentDecisionFlow.headline}</strong>
              </div>
            </div>
            <div className="agentDecisionSteps">
              {agentDecisionFlow.steps.map((step) => (
                <div className={`agentDecisionStep step-${step.state}`} key={step.label}>
                  <span>{step.label}</span>
                  <strong>{step.value}</strong>
                </div>
              ))}
            </div>
          </div>

          {idealDemoRun ? (
            <div className="idealRunPanel">
              <div className="planHeader">
                <div>
                  <h3>Dry Run تشغيل كامل</h3>
                  <p>عرض تنفيذي بدون حفظ أو MQTT: يحسب الماء والدفعات ويعرض الأمر المتوقع لو كانت المنظومة جاهزة.</p>
                </div>
                <div className="planDecision">
                  <span>{idealDemoRun.mode}</span>
                  <strong>{idealDemoRun.readiness.can_prepare_command ? "جاهز للتحضير" : "توجد نواقص"}</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>الأرض</span>
                  <strong>{idealDemoRun.land.name}</strong>
                </div>
                <div>
                  <span>الخزان المتاح</span>
                  <strong>{Number(idealDemoRun.tank.usable_liters ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>نقص الخزان</span>
                  <strong>{Number(idealDemoRun.readiness.needs_refill_liters ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>دفعات الري</span>
                  <strong>{idealDemoRun.batches.length}</strong>
                </div>
                <div>
                  <span>الجهاز</span>
                  <strong>{idealDemoRun.device.uid}</strong>
                </div>
              </div>
              <div className="demoFlow">
                {idealDemoRun.timeline.map((item) => (
                  <div className="timelineItem" key={`ideal-${item.step}`}>
                    <strong>{item.step}. {item.title}</strong>
                    <span>{item.result}</span>
                  </div>
                ))}
              </div>
              {idealDemoRun.command_preview ? (
                <div className="codePreview" dir="ltr">
                  <span>Topic: {idealDemoRun.device.topic}</span>
                  <pre>{JSON.stringify(idealDemoRun.command_preview, null, 2)}</pre>
                </div>
              ) : null}
              {idealDemoRun.readiness.missing.length ? (
                <div className="pitchBox">
                  <span>نواقص قبل التنفيذ الحقيقي</span>
                  <strong>{idealDemoRun.readiness.missing.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="landAgentPanel demoAgentPanel">
            <div className="boardHeader">
              <div>
                <h3>Agent الديمو التشغيلي</h3>
                <p>اختار أرض محفوظة وشغل الـ Agent حتى يقرأ البيانات الحقيقية ويجهز قرار تشغيل قابل للاعتماد.</p>
              </div>
              <div className="actionsRow">
                <button onClick={runOperationsAgent}>تشغيل Agent</button>
                <button className="secondary" onClick={runDemoWorkflowCheck}>فحص مسار الديمو</button>
                <button className="secondary" onClick={runIdealDemoDryRun}>Dry Run كامل</button>
                <button className="secondary" onClick={() => runAutopilotScan(false)}>Autopilot</button>
                <button className="secondary" onClick={() => runAutopilotScan(true)}>تنفيذ تلقائي آمن</button>
              </div>
            </div>
            <div className="toolHubGrid demoToolHub">
              <article className="toolCard toolCardPrimary">
                <span>One Click</span>
                <h3>تشغيل الفحص الذكي</h3>
                <p>يشغل الفحص العملي الكامل بدون MQTT: جاهزية الأرض، ميزانية الخزان، وقرار Autopilot.</p>
                <button onClick={runSmartWorkflow}>تشغيل الفحص</button>
              </article>
              <article className="toolCard">
                <span>Tank</span>
                <h3>خزان بدون حساس</h3>
                <p>{`السعة ${demoTankCapacity.toFixed(0)} L، الموجود ${Number(tankCurrentLiters || 0).toFixed(0)} L، والتعبئة اليومية ${dailyRefillLiters.toFixed(0)} L.`}</p>
                <button className="secondary" onClick={() => setDemoTankLiters(Math.min(demoTankCapacity, Math.max(0, Number(tankCurrentLiters) || 0) + dailyRefillLiters))}>تحديث العرض</button>
              </article>
              <article className="toolCard">
                <span>Advanced</span>
                <h3>أوامر متقدمة</h3>
                <p>تشغيل Agent أو Autopilot اليدوي يبقى متاحاً عند الحاجة، لكنه ليس المسار الرئيسي للعرض.</p>
                <details className="inlineAdvancedActions">
                  <summary>فتح الأدوات</summary>
                  <div className="actionsRow">
                    <button className="secondary" onClick={runOperationsAgent}>Agent</button>
                    <button className="secondary" onClick={runDemoWorkflowCheck}>فحص الديمو</button>
                    <button className="secondary" onClick={runIdealDemoDryRun}>Dry Run</button>
                    <button className="secondary" onClick={() => runAutopilotScan(false)}>Autopilot</button>
                  </div>
                </details>
              </article>
            </div>
            <div className="fields">
              <label>
                الأرض التي يعمل عليها Agent
                <select value={selectedLandId} onChange={(event) => selectSavedLand(event.target.value)}>
                  <option value="">اختر أرض محفوظة</option>
                  {lands.map((land) => (
                    <option key={land.id} value={land.id}>
                      {land.name} / {Number(land.area_m2).toFixed(0)} م2
                    </option>
                  ))}
                </select>
              </label>
              <label>
                ماء الخزان الآن
                <input value={tankCurrentLiters} onChange={(event) => setTankCurrentLiters(event.target.value)} />
              </label>
              <label>
                تعبئة الخزان اليومية
                <input value={tankDailyRefillLiters} onChange={(event) => setTankDailyRefillLiters(event.target.value)} />
              </label>
              <label>
                احتياطي الخزان
                <input value={tankReserveLiters} onChange={(event) => setTankReserveLiters(event.target.value)} />
              </label>
            </div>
            <textarea
              value={agentMessage}
              onChange={(event) => setAgentMessage(event.target.value)}
              placeholder="مثال: افحص الأرض وجهز أمر ري إذا الخزان يكفي والجهاز جاهز"
            />
            <div className="quickQuestionRow">
              {[
                "افحص الأرض وجهز قرار ري إذا الخزان يكفي والجهاز جاهز",
                "هل أقدر أشغل الري الآن؟ لا تجهز أمر إذا الخزان ناقص",
                "اعرض لي أدواتك وسبب القرار",
                "جهز خطة تشغيل آمنة بدون إرسال MQTT"
              ].map((message) => (
                <button className="ghostButton" key={message} onClick={() => setAgentMessage(message)}>
                  {message}
                </button>
              ))}
            </div>
            {agentRun ? (
              <div className="agentResult">
                <div className="planHeader">
                  <div>
                    <h3>{agentRun.agent.agent_name}</h3>
                    <p>{agentRun.agent.summary}</p>
                    <p>مصدر Agent: {agentRun.source === "gemini_agent" ? "Gemini + أدوات المنصة" : "قواعد تشغيلية احتياطية"}</p>
                  </div>
                  <div className="planDecision">
                    <span>{agentRun.agent.decision}</span>
                    <strong>{Number(agentRun.agent.confidence ?? 0).toFixed(2)}</strong>
                  </div>
                </div>
                <div className="demoFlow">
                  {agentRun.agent.tool_trace.map((tool, index) => (
                    <div className="timelineItem" key={`demo-${tool.tool}-${index}`}>
                      <strong>{tool.tool} / {tool.status}</strong>
                      <span>{tool.result}</span>
                    </div>
                  ))}
                </div>
                <div className="readyDemoGrid">
                  <div className="readyDemoPanel">
                    <h3>الأمر المقترح</h3>
                    <div className="codePreview" dir="ltr">
                      <span>Topic: {agentRun.agent.proposed_command.mqtt_topic || "not prepared"}</span>
                      <pre>{JSON.stringify(agentRun.agent.proposed_command.payload, null, 2)}</pre>
                    </div>
                    <div className="actionsRow agentCommandActions">
                      <button
                        onClick={approveAgentCommand}
                        disabled={
                          !agentRun.agent.proposed_command.allowed_to_prepare
                          || Number(agentRun.agent.proposed_command.payload.duration_seconds ?? 0) <= 0
                          || Number(agentRun.agent.proposed_command.payload.duration_seconds ?? 0) > 1800
                        }
                      >
                        اعتماد وإرسال عبر MQTT
                      </button>
                      <span>
                        {Number(agentRun.agent.proposed_command.payload.duration_seconds ?? 0) > 1800
                          ? "المدة أكبر من حد الأمان 1800 ثانية"
                          : agentRun.agent.proposed_command.allowed_to_prepare
                            ? "يمر عبر مراجعة الأمان قبل النشر"
                            : "غير جاهز للإرسال"}
                      </span>
                    </div>
                  </div>
                  <div className="readyDemoPanel">
                    <h3>فحوص الأمان</h3>
                    <div className="decisionStack">
                      {agentRun.agent.safety_checks.map((check, index) => (
                        <div key={`demo-${check.name}-${index}`}>
                          <span>{check.name} / {check.status}</span>
                          <strong>{check.details}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {demoWorkflowCheck ? (
              <div className="demoWorkflowCheck">
                <div className="planHeader">
                  <div>
                    <h3>نتيجة فحص مسار الديمو</h3>
                    <p>{demoWorkflowCheck.summary}</p>
                  </div>
                  <div className="planDecision">
                    <span>{demoWorkflowCheck.label}</span>
                    <strong>{Number(demoWorkflowCheck.score ?? 0).toFixed(0)}/100</strong>
                  </div>
                </div>
                <div className="demoWorkflowSteps">
                  {demoWorkflowCheck.steps.map((item) => (
                    <div className={`workflowStep workflow-${item.status}`} key={item.id}>
                      <strong>{item.title}</strong>
                      <span>{item.proof}</span>
                      {item.gap ? <small>{item.gap}</small> : null}
                      <em>{item.action}</em>
                    </div>
                  ))}
                </div>
                {demoWorkflowCheck.blocking.length ? (
                  <div className="pitchBox">
                    <span>نقاط تمنع الديمو الكامل</span>
                    <strong>{demoWorkflowCheck.blocking.map((item) => item.title).join(" / ")}</strong>
                  </div>
                ) : null}
              </div>
            ) : null}
            {autopilotScan ? (
              <div className="autopilotPanel">
                <div className="planHeader">
                  <div>
                    <h3>Autopilot Scan</h3>
                    <p>{autopilotScan.summary}</p>
                  </div>
                  <div className="planDecision">
                    <span>جاهزية التشغيل</span>
                    <strong>{Number(autopilotScan.score ?? 0).toFixed(0)}/100</strong>
                  </div>
                </div>
                <div className="reportColumns">
                  <div><span>الأراضي</span><strong>{autopilotScan.portfolio.lands}</strong></div>
                  <div><span>جاهزة للتحضير</span><strong>{autopilotScan.portfolio.readyToPrepare}</strong></div>
                  <div><span>تحتاج مراجعة</span><strong>{autopilotScan.portfolio.needsHumanReview}</strong></div>
                  <div><span>متوقفة</span><strong>{autopilotScan.portfolio.blocked}</strong></div>
                  <div><span>نُفذت تلقائياً</span><strong>{autopilotScan.portfolio.autoExecuted ?? 0}</strong></div>
                </div>
                <div className="autopilotDecisions">
                  {autopilotScan.decisions.map((item) => (
                    <div className={`autopilotDecision priority-${item.priority}`} key={item.land_id}>
                      <div>
                        <strong>{item.land_name}</strong>
                        <span>{item.decision} / {item.priority} / ثقة {Number(item.confidence ?? 0).toFixed(2)} / auto {item.auto_enabled ? "ON" : "OFF"}</span>
                      </div>
                      <p>{item.reason}</p>
                      {item.water ? (
                        <div className="miniMetrics">
                          <span>رية {Number(item.water.liters_per_irrigation ?? 0).toFixed(1)} L</span>
                          <span>{irrigationModeLabel(item.water.irrigation_mode ?? irrigationMode)}</span>
                          <span>دفعة آمنة {Number(item.water.safe_batch_liters ?? 0).toFixed(1)} L</span>
                          <span>{Number(item.water.duration_seconds ?? 0).toFixed(0)}s</span>
                          <span>نقص خزان {Number(item.water.tank_shortage_liters ?? 0).toFixed(1)} L</span>
                        </div>
                      ) : null}
                      {item.evidence?.tank ? (
                        <div className="tankEvidence">
                          <span>مصدر الخزان: {item.evidence.tank.source === "iot_telemetry" ? "ESP32" : item.evidence.tank.source === "missing" ? "غير متوفر" : "إدخال يدوي"}</span>
                          <strong>
                            {Number(item.evidence.tank.available_liters ?? 0).toFixed(1)} L
                            {item.evidence.tank.level_percent !== null && item.evidence.tank.level_percent !== undefined
                              ? ` / ${Number(item.evidence.tank.level_percent).toFixed(0)}%`
                              : ""}
                          </strong>
                          {item.evidence.tank.device_uid ? <small>{item.evidence.tank.device_uid}</small> : null}
                        </div>
                      ) : null}
                      {item.water?.batch_plan?.length ? (
                        <div className="batchPlan">
                          {item.water.batch_plan.map((batch) => (
                            <div key={`${item.land_id}-${batch.batch}`}>
                              <span>
                                دفعة {batch.batch}: بعد {Number(batch.start_after_minutes ?? 0).toFixed(0)}د / {Number(batch.liters_target ?? 0).toFixed(1)}L / {Number(batch.duration_seconds ?? 0).toFixed(0)}s
                              </span>
                              <button
                                className="miniButton"
                                onClick={() => approveAutopilotDecision(item, batch)}
                                disabled={
                                  item.decision !== "prepare_irrigation"
                                  || !item.device
                                  || Number(batch.duration_seconds ?? 0) <= 0
                                  || Number(batch.duration_seconds ?? 0) > 1800
                                }
                              >
                                اعتماد هذه الدفعة
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {item.device ? <small>ESP32: {item.device.uid}</small> : null}
                      {item.auto_execution ? (
                        <small>
                          Auto execution: {item.auto_execution.status}
                          {item.auto_execution.commandId ? ` / command #${item.auto_execution.commandId}` : ""}
                          {item.auto_execution.error ? ` / ${item.auto_execution.error}` : ""}
                        </small>
                      ) : null}
                      <em>{item.next_action}</em>
                      <button
                        className="miniButton"
                        onClick={() => approveAutopilotDecision(item)}
                        disabled={
                          item.decision !== "prepare_irrigation"
                          || !item.device
                          || !item.water
                          || Number(item.water.duration_seconds ?? 0) <= 0
                          || Number(item.water.duration_seconds ?? 0) > 1800
                        }
                      >
                        اعتماد قرار Autopilot
                      </button>
                    </div>
                  ))}
                </div>
                {landOps?.recent.commands.length ? (
                  <div className="executionTrail">
                    <div className="boardHeader">
                      <div>
                        <h3>أثر التنفيذ بعد الاعتماد</h3>
                        <p>آخر أوامر IoT المحفوظة للأرض المختارة من Supabase.</p>
                      </div>
                    </div>
                    <div className="demoFlow">
                      {landOps.recent.commands.slice(0, 4).map((command) => (
                        <div className="timelineItem" key={`demo-command-${command.id}`}>
                          <strong>Command #{command.id} / {command.status}</strong>
                          <span>
                            {command.payload?.device_uid ?? "device?"} / {Number(command.payload?.duration_seconds ?? 0).toFixed(0)}s
                          </span>
                          <span>
                            {Number(command.payload?.liters_target ?? 0).toFixed(1)} L
                            {command.payload?.batch?.current ? ` / دفعة ${command.payload.batch.current}${command.payload.batch.total ? ` من ${command.payload.batch.total}` : ""}` : ""}
                          </span>
                          <span>
                            Safety: {command.payload?.safety?.ai_review?.decision ?? command.ack_payload?.safety_review?.decision ?? "pending"}
                          </span>
                          {command.published_at ? <small>نشر: {new Date(command.published_at).toLocaleString("ar-IQ")}</small> : null}
                          {command.ack_payload?.status ? (
                            <small>ACK: {command.ack_payload.status} / relay {command.ack_payload.relay_state ?? "?"}</small>
                          ) : null}
                          {command.ack_payload?.error || command.ack_payload?.safety_review?.operator_message ? (
                            <small>{command.ack_payload.safety_review?.operator_message ?? command.ack_payload.error}</small>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="pitchBox">
                    <span>أثر التنفيذ</span>
                    <strong>لم يتم تسجيل أوامر IoT للأرض المختارة بعد. عند اعتماد Agent أو Autopilot سيظهر السجل هنا.</strong>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="reportColumns">
            {dynamicReadyDemo.metrics.map((metric) => (
              <div key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.note}</small>
              </div>
            ))}
          </div>

          <div className="readyDemoGrid">
            <div className="readyDemoPanel">
              <div className="boardHeader">
                <div>
                  <h3>مسار العمل الكامل</h3>
                  <p>من تحديد الأرض إلى قرار الري وأمر الصمام.</p>
                </div>
              </div>
              <div className="readyDemoFlow">
                {dynamicReadyDemo.flow.map((step) => (
                  <div className="timelineItem" key={step.title}>
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                    <small>{step.status}</small>
                  </div>
                ))}
              </div>
            </div>

            <div className="readyDemoPanel">
              <div className="boardHeader">
                <div>
                  <h3>قرار الري النهائي</h3>
                  <p>النظام لا يتعامل مع النخيل كسقاية يومية؛ يحدد الرية وفاصلها.</p>
                </div>
              </div>
              <div className="decisionStack">
                <div>
                  <span>قرار AI</span>
                  <strong>ري مجدول بعد موافقة المشغل</strong>
                </div>
                <div>
                  <span>كمية الرية</span>
                  <strong>{demoPlannedLiters.toFixed(1)} L</strong>
                </div>
                <div>
                  <span>الاحتياج الخام وخطة التوفير</span>
                  <strong>{`${demoRawLiters.toFixed(1)} L / ${demoSavingPercent.toFixed(0)}%`}</strong>
                </div>
                <div>
                  <span>فاصل الري</span>
                  <strong>{`كل ${demoIntervalDays.toFixed(0)} أيام`}</strong>
                </div>
                <div>
                  <span>سبب القرار</span>
                  <strong>لا توجد أمطار مؤثرة، لا توجد مؤشرات آفات عالية، والجهاز متصل بآخر ACK.</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="readyDemoPanel liveTankPanel">
            <div className="boardHeader">
              <div>
                <h3>خزان الماء أثناء أمر الإرواء</h3>
                <p>عرض بصري لكمية الماء المتبقية عند تشغيل الرية حسب تدفق الصمام.</p>
              </div>
              <div className="actionsRow">
                <button
                  onClick={() => setDemoIrrigationRunning((current) => !current)}
                  disabled={demoUsableLiters <= 0}
                >
                  {demoIrrigationRunning ? "إيقاف الصمام" : "تشغيل الرية"}
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const current = Math.min(demoTankCapacity, Math.max(0, Number(tankCurrentLiters) || demoTankCapacity));
                    setDemoTankLiters(current);
                    setDemoIrrigationRunning(false);
                  }}
                >
                  تعبئة/إعادة ضبط
                </button>
              </div>
            </div>
            <div className="tankDemoGrid">
              <div className="tankVisual" aria-label="مستوى الخزان">
                <div className="tankWater" style={{ height: `${demoTankPercent}%` }} />
                <div className="tankReadout">
                  <strong>{demoTankLiters.toFixed(1)} L</strong>
                  <span>{demoTankPercent.toFixed(0)}%</span>
                </div>
              </div>
              <div className="decisionStack">
                <div>
                  <span>حالة الصمام</span>
                  <strong>{demoIrrigationRunning ? "ON / الماء ينقص الآن" : "OFF / جاهز"}</strong>
                </div>
                <div>
                  <span>المتاح فوق الاحتياطي</span>
                  <strong>{demoUsableLiters.toFixed(1)} L</strong>
                </div>
                <div>
                  <span>الرية المطلوبة</span>
                  <strong>{demoTargetLiters.toFixed(1)} L</strong>
                  <small>{`المخطط الكامل ${demoPlannedLiters.toFixed(1)} L / كل ${demoIntervalDays.toFixed(0)} أيام`}</small>
                </div>
                <div>
                  <span>قرار الخزان</span>
                  <strong>
                    {demoShortageLiters > 0
                      ? `لا يكفي. يحتاج تعبئة ${demoShortageLiters.toFixed(1)} L قبل الرية الكاملة.`
                      : "يكفي للرية الكاملة مع بقاء الاحتياطي."}
                  </strong>
                </div>
              </div>
            </div>
          </div>

          <div className="readyDemoGrid">
            <div className="readyDemoPanel">
              <h3>رسالة MQTT المتوقعة</h3>
              <div className="codePreview" dir="ltr">
                <span>Topic: {dynamicReadyDemo.command.topic}</span>
                <pre>{JSON.stringify(dynamicReadyDemo.command.payload, null, 2)}</pre>
              </div>
            </div>

            <div className="readyDemoPanel">
              <h3>ماذا يرى كل دور</h3>
              <div className="roleSplit">
                <div>
                  <span>المستخدم</span>
                  <strong>حالة الأرض، صحة النبات، آخر تحليل، جدول الري المقترح، والتنبيهات.</strong>
                </div>
                <div>
                  <span>Admin</span>
                  <strong>إضافة المستخدمين، ربط الأراضي، اعتماد الجرد النباتي، توليد القرار، إرسال MQTT، ومتابعة ACK.</strong>
                </div>
              </div>
              <div className="pitchBox">
                <span>قيمة العرض</span>
                <strong>
                  هذه الشاشة تحول الفكرة إلى قصة تشغيلية واضحة: المنصة تجمع بيانات حقيقية،
                  تتخذ قراراً محسوباً، وتمنع التشغيل إذا الدليل ناقص.
                </strong>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {landOps && activeSection === "ops" ? (
        <section className={`opsCenter opsView-${opsView}`}>
          <div className="boardHeader">
            <div>
              <h2>{selectedPottedPlant ? "مركز عمليات النبات" : "مركز عمليات الأرض"}</h2>
              <p>
                {selectedPottedPlant
                  ? `${selectedPottedPlant.name} / ${landOps.land.name}`
                  : `${landOps.land.name} / ${landOps.land.crop_hint ?? "محصول غير محدد"}`}
              </p>
            </div>
            <div className="actionsRow">
              <button className="secondary" onClick={() => loadLandOps()}>{selectedPottedPlant ? "تحديث سجل النبات" : "تحديث سجل الأرض"}</button>
              {isAdmin ? (
                <>
                  <button onClick={generateUnifiedAiDecision}>قرار AI موحد</button>
                  <button className="secondary" onClick={generateIrrigationSchedulePlan}>جدولة ري AI</button>
                  <button className="secondary" onClick={generateEvidenceReport}>تقرير دليل الأرض AI</button>
                  <button className="secondary" onClick={generatePestResponse}>استجابة آفات AI</button>
                  <button className="secondary" onClick={generateWeatherRiskInsight}>تنبيه طقس وري AI</button>
                  <button className="secondary" onClick={generateSensorAiInsight}>تحليل الحساسات AI</button>
                  <button className="secondary" onClick={generateHardwareReadinessReport}>جاهزية ESP32 AI</button>
                  <button className="secondary" onClick={generateOperatorChecklist}>مهام المشغل AI</button>
                  <button className="secondary" onClick={generateFieldWorkOrders}>أوامر عمل AI</button>
                  <button className="secondary" onClick={runRelayDiagnosticTest}>اختبار Relay 5 ثواني</button>
                </>
              ) : null}
              <a className="buttonLink secondary" href={`/reports/lands/${landOps.land.id}`} target="_blank" rel="noreferrer">
                فتح تقرير الأرض
              </a>
              {isAdmin ? <button className="secondary" onClick={generateOpsActionPlan}>خطة تنفيذ AI</button> : null}
            </div>
          </div>
          {isAdmin ? (
            <div className="opsViewIntro">
              <span>صفحة التشغيل الحالية</span>
              <strong>{selectedOpsView.title}</strong>
              <p>{selectedOpsView.description}</p>
            </div>
          ) : null}
          <div className={`opsRunway opsRunway-${opsView}`}>
            <div className="opsRunwayLead">
              <span>مسار الصفحة</span>
              <strong>{opsRunwayTitle}</strong>
              <p>{opsRunwayDetail}</p>
            </div>
            <div className="opsReadinessStrip">
              {opsReadinessSteps.map((step) => (
                <div className={step.ready ? "ready" : "blocked"} key={step.label}>
                  <span>{step.label}</span>
                  <strong>{step.value}</strong>
                </div>
              ))}
            </div>
            {isAdmin ? (
              <div className="opsPrimaryAction">
                {opsView === "overview" ? (
                  <button onClick={runSmartWorkflow}>تشغيل الفحص الذكي</button>
                ) : opsView === "recommendations" ? (
                  <button onClick={generateWaterBudgetPlan}>{selectedPottedPlant ? "حساب ري النبات" : "حساب الماء والخزان"}</button>
                ) : opsView === "auto" ? (
                  <button onClick={() => runAutopilotScan(true)} disabled={!esp32Online || !latestRecommendation}>
                    تشغيل Autopilot آمن
                  </button>
                ) : opsView === "manual" ? (
                  <div className="actionsRow">
                    <button className="dangerButton" onClick={sendManualIrrigationOverride} disabled={!esp32Online}>
                      إرسال أمر يدوي
                    </button>
                    <button className="secondary dangerButton" onClick={sendEmergencyStopCommand} disabled={!selectedLandId}>
                      إيقاف فوري
                    </button>
                  </div>
                ) : opsView === "hardware" ? (
                  <button onClick={runRelayDiagnosticTest} disabled={!selectedLandId}>
                    اختبار Relay 5 ثواني
                  </button>
                ) : opsView === "live" ? (
                  <button onClick={() => loadLandOps()} disabled={!selectedLandId}>
                    تحديث المراقبة
                  </button>
                ) : (
                  <button onClick={runOperationsAgent}>تشغيل Agent</button>
                )}
                <small>
                  {opsView === "manual"
                    ? "مسار خطر: استخدمه فقط وأنت تشاهد المضخة."
                    : opsView === "auto"
                      ? "يتوقف تلقائيا إذا لا توجد توصية أو ESP32 غير متصل."
                      : "هذا هو الزر الأساسي لهذه الصفحة؛ بقية الأدوات الثانوية بالأسفل."}
                </small>
              </div>
            ) : null}
          </div>
          {isAdmin ? (
            <div className="irrigationModeControl">
              <div>
                <span>مود الري الحالي</span>
                <strong>{selectedIrrigationMode.label}</strong>
                <p>{selectedIrrigationMode.description}</p>
                <small>هذا الاختيار يؤثر على التحليل، ميزانية الماء، الجدولة، و Autopilot قبل إرسال أي أمر ESP32.</small>
              </div>
              <select value={irrigationMode} onChange={(event) => setIrrigationMode(event.target.value as IrrigationModeOption)}>
                {IRRIGATION_MODE_OPTIONS.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
              <label className="switchLine">
                <input
                  type="checkbox"
                  checked={autoIrrigationEnabled}
                  onChange={(event) => setAutoIrrigationEnabled(event.target.checked)}
                />
                <span>تفعيل الري التلقائي لهذه الأرض</span>
              </label>
              <label className="fieldLine compactField">
                <span>حد تشغيل الري التلقائي من الرطوبة</span>
                <input
                  type="number"
                  min="5"
                  max="80"
                  value={autoMoistureThresholdPercent}
                  onChange={(event) => setAutoMoistureThresholdPercent(event.target.value)}
                />
                <small>إذا نزلت قراءة HW-030 تحت هذا الرقم، يصبح الري التلقائي مؤهلاً للتشغيل.</small>
              </label>
              <button className="secondary" onClick={saveLand} disabled={!selectedLandId && !selectedPottedPlantId}>
                حفظ إعدادات الري
              </button>
            </div>
          ) : null}
          <div className="sensorSummaryPanel">
            <div className="boardHeader">
              <div>
                <h3>قراءات الحساسات الآن</h3>
                <p>
                  {latestSensorReading
                    ? `${latestSensorReading.device_uid} / ${new Date(latestSensorReading.captured_at).toLocaleString("ar-IQ")}`
                    : "لا توجد قراءة محفوظة لهذه الأرض بعد."}
                </p>
              </div>
              <button className="secondary" onClick={() => selectedLandId ? loadLandOps(selectedLandId) : undefined} disabled={!selectedLandId}>
                تحديث الحساسات
              </button>
            </div>
            <div className="sensorMetricGrid">
              <div>
                <span>رطوبة التربة</span>
                <strong>
                  {latestSoilMoisture !== null && latestSoilMoisture !== undefined
                    ? `${Number(latestSoilMoisture).toFixed(0)}%`
                    : "غير متاحة"}
                </strong>
                <small>{latestSensorReading?.has_soil_moisture_sensor ? "HW-030 فعال" : "بانتظار قراءة حساس التربة"}</small>
              </div>
              <div>
                <span>مستوى الخزان</span>
                <strong>
                  {latestTank
                    ? `${Number(latestTank.available_liters ?? 0).toFixed(1)} L`
                    : `${Number(tankCurrentLiters || 0).toFixed(1)} L`}
                </strong>
                <small>
                  {latestTank?.level_percent !== null && latestTank?.level_percent !== undefined
                    ? `${Number(latestTank.level_percent).toFixed(0)}% / ${latestTank.sensor_source ?? "حساس خزان"}`
                    : "قيمة يدوية أو لا توجد قراءة خزان"}
                </small>
              </div>
              <div>
                <span>الصمام</span>
                <strong>{latestSensorReading?.valve_state ?? "غير معروف"}</strong>
                <small>آخر حالة مرسلة من ESP32</small>
              </div>
              <div>
                <span>التدفق</span>
                <strong>
                  {latestSensorReading?.flow_liters_per_minute
                    ? `${Number(latestSensorReading.flow_liters_per_minute).toFixed(1)} L/min`
                    : `${configuredFlowRateLpm.toFixed(1)} L/min`}
                </strong>
                <small>يحدد زمن تشغيل المضخة</small>
              </div>
              <div>
                <span>شرط الري التلقائي</span>
                <strong>
                  {latestSoilMoisture === null || latestSoilMoisture === undefined
                    ? "بانتظار الحساس"
                    : soilMoistureAutoTrigger
                      ? "مؤهل للتشغيل"
                      : "متوقف لأن التربة رطبة"}
                </strong>
                <small>
                  الحد {autoMoistureThreshold.toFixed(0)}% / الحالي {latestSoilMoisture !== null && latestSoilMoisture !== undefined ? `${Number(latestSoilMoisture).toFixed(0)}%` : "غير متاح"}
                </small>
              </div>
            </div>
          </div>
          <div className="systemRecommendationPanel">
            <div>
              <span>توصيات الري</span>
              <strong>يدوي / دوري / تلقائي</strong>
              <p>كل توصية تعرض كمية الماء، مدة التشغيل، وشرط التنفيذ اعتماداً على آخر قراءة حساسات وتدفق المضخة.</p>
            </div>
            {latestRecommendation && isAdmin ? (
              <button
                className="secondary"
                onClick={() => sendIotCommand(latestRecommendation)}
                disabled={!esp32Online || Number(latestRecommendation.recommended_duration_seconds ?? 0) <= 0}
              >
                إرسال آخر توصية
              </button>
            ) : null}
          </div>
          <div className="recommendationModeGrid">
            <article>
              <span>توصية يدوية</span>
              <strong>{manualRecommendationLiters.toFixed(selectedPottedPlant ? 3 : 1)} L / {manualRecommendationDurationSeconds.toFixed(0)}s</strong>
              <p>
                {selectedPottedPlant
                  ? "توصية يدوية آمنة للنبات المختار، مبنية على آخر توصية محفوظة وحجم الإناء."
                  : "تشغيل مباشر بصلاحية المدير. مناسب للعرض أو التصحيح السريع وأنت تشاهد النبات والصمام."}
              </p>
              <small>
                الزمن المحسوب من التدفق الحالي: {manualRecommendationDurationSeconds}s عند {configuredFlowRateLpm.toFixed(1)} L/min.
                {selectedPottedPlant ? " تم تجنب قيمة 50L الافتراضية لأنها غير مناسبة للنباتات الفردية." : ""}
              </small>
            </article>
            <article>
              <span>توصية دورية</span>
              <strong>
                {latestRecommendation
                  ? `${latestRecommendationLiters.toFixed(1)} L كل ${Number(periodicIntervalDays || 1).toFixed(0)} يوم`
                  : "تحتاج تحليل"}
              </strong>
              <p>
                {latestRecommendation
                  ? `آخر توصية #${latestRecommendation.id} / ${new Date(latestRecommendation.created_at).toLocaleString("ar-IQ")}`
                  : "شغّل تحليل صورة أو تحليل النبات حتى تظهر كمية دورية محفوظة."}
              </p>
              <small>{latestRecommendation ? `${latestRecommendationDuration}s تشغيل، ${latestRecommendation.status}` : "لا توجد توصية محفوظة."}</small>
            </article>
            <article className={automaticReady ? "readyRecommendation" : "blockedRecommendation"}>
              <span>توصية تلقائية</span>
              <strong>{automaticReady ? "جاهزة للإرسال" : "غير جاهزة"}</strong>
              <p>
                {automaticReady
                  ? "الري التلقائي مفعل، ESP32 متصل، التربة تحت حد الرطوبة، والخزان يكفي لتنفيذ آخر توصية."
                  : "تحتاج تفعيل الري التلقائي، اتصال ESP32، توصية محفوظة، قراءة رطوبة أقل من الحد، وخزان كافٍ."}
              </p>
              <small>
                خزان {Number(latestTankLiters || 0).toFixed(1)} L / مطلوب {latestRecommendationLiters.toFixed(1)} L / رطوبة {latestSoilMoisture !== null && latestSoilMoisture !== undefined ? `${Number(latestSoilMoisture).toFixed(0)}%` : "غير متاحة"} / ESP32 {esp32Online ? "متصل" : "غير متصل"}
              </small>
            </article>
          </div>
          {waterBudget && selectedWaterAllocation ? (
            <div className="agroInsightPanel">
              <div>
                <span>بيانات زراعية مجانية</span>
                <strong>
                  {selectedAgronomicAdjustment
                    ? `${selectedAgronomicAdjustment.label} ×${Number(selectedAgronomicAdjustment.factor ?? 1).toFixed(2)}`
                    : "اضغط حساب الماء لجلب Open-Meteo و SoilGrids"}
                </strong>
                <p>
                  {selectedAgronomicAdjustment?.reasons?.[0]
                    ?? "تظهر هنا ET0، رطوبة التربة المتوقعة، ونوع التربة عند توفرها."}
                </p>
                <small>
                  التأثير الحسابي: المنصة تضرب كمية الري الأساسية بعامل البيانات الزراعية.
                  مثال: ×1.20 يعني زيادة 20% بسبب تبخر/نتح عالي أو تربة تفقد الماء بسرعة،
                  و ×0.90 يعني تقليل 10% بسبب رطوبة أو تربة تحتفظ بالماء.
                </small>
              </div>
              <div className="agroInsightMetrics">
                <div>
                  <span>ET0</span>
                  <strong>
                    {selectedAgronomicAdjustment?.openMeteo
                      ? `${Number(selectedAgronomicAdjustment.openMeteo.et0DailyAverageMm ?? 0).toFixed(1)} mm/day`
                      : "غير متاح"}
                  </strong>
                  <small>تبخر-نتح مرجعي: كلما ارتفع زاد احتياج الري.</small>
                </div>
                <div>
                  <span>رطوبة التربة المتوقعة</span>
                  <strong>
                    {selectedAgronomicAdjustment?.openMeteo?.soilMoisture0To9cm !== null && selectedAgronomicAdjustment?.openMeteo?.soilMoisture0To9cm !== undefined
                      ? Number(selectedAgronomicAdjustment.openMeteo.soilMoisture0To9cm).toFixed(2)
                      : "غير متاحة"}
                  </strong>
                  <small>تقدير من Open-Meteo، يساعد بتقليل/زيادة الماء قبل تشغيل المضخة.</small>
                </div>
                <div>
                  <span>نوع التربة</span>
                  <strong>{selectedAgronomicAdjustment?.soilGrids?.textureClass ?? "غير متاح"}</strong>
                  <small>الرمل يحتاج دفعات أقرب، والطين يحتفظ بالماء أكثر.</small>
                </div>
                <div>
                  <span>المصدر</span>
                  <strong>Open-Meteo + SoilGrids</strong>
                  <small>مجاني وبدون مفاتيح API، ويستخدم قبل قرار MQTT.</small>
                </div>
              </div>
            </div>
          ) : isAdmin && opsView === "recommendations" ? (
            <div className="agroInsightPanel">
              <div>
                <span>{selectedPottedPlant ? "توصية نبات فردي" : "بيانات زراعية مجانية"}</span>
                <strong>لم تُحسب بعد</strong>
                <p>
                  {selectedPottedPlant
                    ? "اضغط حساب ري النبات حتى تعيد المنصة تحليل الصورة المحفوظة وتستخدم آخر قراءة رطوبة من ESP32 المرتبط بالنبات."
                    : "اضغط “حساب الماء” حتى تجلب المنصة ET0 من Open-Meteo وخواص التربة من SoilGrids وتدخلها في كمية الري."}
                </p>
                <small>
                  {selectedPottedPlant
                    ? "النباتات الداخلية لا تستخدم رطوبة Open-Meteo؛ القرار يعتمد على صورة النبات وحساس التربة الحقيقي."
                    : "الفائدة: هذه البيانات تعدل كمية الماء بدل الاعتماد فقط على نوع النبات وعدده."}
                </small>
              </div>
              <button className="secondary" onClick={generateWaterBudgetPlan}>{selectedPottedPlant ? "حساب ري النبات" : "حساب الماء"}</button>
            </div>
          ) : null}
          {isAdmin ? (
            <div className="toolHubGrid">
              <article className="toolCard toolCardPrimary">
                <span>Workflow</span>
                <h3>تشغيل الفحص الذكي</h3>
                <p>يفحص الأرض، النباتات، الطقس، الخزان اليدوي، و ESP32 بدون إرسال أمر ري.</p>
                <button onClick={runSmartWorkflow}>تشغيل الآن</button>
              </article>
              <article className="toolCard">
                <span>Water Tank</span>
                <h3>الخزان اليدوي</h3>
                <p>{`المتاح الآن ${Number(tankCurrentLiters || 0).toFixed(0)} L + تعبئة يومية ${dailyRefillLiters.toFixed(0)} L، والاحتياطي ${demoTankReserve.toFixed(0)} L.`}</p>
                <button className="secondary" onClick={generateWaterBudgetPlan}>{selectedPottedPlant ? "حساب ري النبات" : "حساب الماء"}</button>
              </article>
              <article className="toolCard autoIrrigationCard">
                <span>AI Autopilot</span>
                <h3>ري تلقائي بدون موافقة</h3>
                <p>إذا وجد AI توصية صالحة، والـ ESP32 متصل، والخزان يكفي، والري التلقائي مفعل للأرض، ينشر MQTT مباشرة بدون زر اعتماد إضافي.</p>
                <button onClick={() => runAutopilotScan(true)}>تشغيل تلقائي آمن</button>
              </article>
              <article className="toolCard">
                <span>Hardware</span>
                <h3>اختبار ESP32</h3>
                <p>يرسل أمر Relay قصير 5 ثواني للتأكد أن القطعة والريلاي يستقبلان MQTT.</p>
                <button className="secondary" onClick={runRelayDiagnosticTest}>اختبار Relay</button>
              </article>
              <article className="toolCard manualOverrideCard">
                <span>Manual Control</span>
                <h3>ري يدوي مباشر</h3>
                <p>صلاحية المدير المطلقة: يرسل MQTT مباشرة ويتجاوز مراجعة AI. استخدمه فقط وأنت تراقب الصمام.</p>
                <div className="compactFields">
                  <label>
                    المدة / ثانية
                    <input value={manualIrrigationDurationSeconds} onChange={(event) => setManualIrrigationDurationSeconds(event.target.value)} />
                  </label>
                  <label>
                    اللترات
                    <input value={manualIrrigationLitersTarget} onChange={(event) => setManualIrrigationLitersTarget(event.target.value)} />
                  </label>
                  <label>
                    تدفق الماطور L/min
                    <input value={flowRate} onChange={(event) => setFlowRate(event.target.value)} />
                  </label>
                </div>
                <div className="pitchBox">
                  <span>حساب الزمن حسب الماطور</span>
                  <strong>
                    {manualCalculatedDurationSeconds > 0
                      ? `${manualIrrigationLitersTarget} L تحتاج ${manualCalculatedDurationSeconds}s عند ${configuredFlowRateLpm.toFixed(1)} L/min`
                      : "اكتب كمية اللترات حتى نحسب زمن التشغيل"}
                  </strong>
                  <button
                    className="secondary"
                    onClick={() => {
                      if (manualCalculatedDurationSeconds > 0) setManualIrrigationDurationSeconds(String(manualCalculatedDurationSeconds));
                    }}
                    disabled={manualCalculatedDurationSeconds <= 0}
                  >
                    استخدام الزمن المحسوب
                  </button>
                </div>
                <div className="actionsRow">
                  <button className="dangerButton" onClick={sendManualIrrigationOverride}>إرسال يدوي مباشر</button>
                  <button className="secondary dangerButton" onClick={sendEmergencyStopCommand}>إيقاف الري فوراً</button>
                </div>
              </article>
              <article className="toolCard">
                <span>AI Decision</span>
                <h3>جدولة الري</h3>
                <p>ينشئ جدولة ري مع فحص الخزان، وتبقى موافقة المدير مطلوبة قبل التشغيل.</p>
                <button className="secondary" onClick={generateIrrigationSchedulePlan}>جدولة الآن</button>
              </article>
              <article className="toolCard">
                <span>Report</span>
                <h3>تقرير الأرض</h3>
                <p>يفتح صفحة مختصرة لعرض الأرض، الصور، النباتات، وقرارات الري المحفوظة.</p>
                <a className="buttonLink secondary" href={`/reports/lands/${landOps.land.id}`} target="_blank" rel="noreferrer">فتح التقرير</a>
              </article>
            </div>
          ) : null}
          {isAdmin ? (
            <details className="advancedActions">
              <summary>أدوات متقدمة</summary>
              <div className="actionsRow">
                <button className="secondary" onClick={() => loadLandOps()}>تحديث السجل</button>
                <button className="secondary" onClick={generateUnifiedAiDecision}>قرار AI موحد</button>
                <button className="secondary" onClick={generateEvidenceReport}>تقرير دليل الأرض</button>
                <button className="secondary" onClick={generatePestResponse}>استجابة آفات</button>
                <button className="secondary" onClick={generateWeatherRiskInsight}>تنبيه طقس وري</button>
                <button className="secondary" onClick={generateSensorAiInsight}>تحليل الحساسات</button>
                <button className="secondary" onClick={generateHardwareReadinessReport}>جاهزية ESP32</button>
                <button className="secondary" onClick={generateOperatorChecklist}>مهام المشغل</button>
                <button className="secondary" onClick={generateFieldWorkOrders}>أوامر عمل</button>
                <button className="secondary" onClick={generateOpsActionPlan}>خطة تنفيذ</button>
              </div>
            </details>
          ) : null}
          <div className="opsDecision">
            <span>قرار تشغيلي الآن</span>
            <strong>{landOps.summary.operationalDecision}</strong>
          </div>
          <div className={`liveIrrigationPanel live-${liveIrrigation.status}`}>
            <div className="boardHeader">
              <div>
                <h3>مراقبة الري الحي</h3>
                <p>
                  {liveIrrigation.command
                    ? `أمر #${liveIrrigation.command.id} / ${liveIrrigation.command.payload?.device_uid ?? "ESP32"}`
                    : "لا يوجد أمر ري محفوظ لهذه الأرض بعد."}
                </p>
              </div>
              <div className="planDecision">
                <span>
                  {liveIrrigation.relayState === "ON"
                    ? "الصمام مفتوح"
                    : liveIrrigation.relayState === "OFF"
                      ? "الصمام مغلق"
                      : "حالة الصمام غير مؤكدة"}
                </span>
                <strong>
                  {liveIrrigation.failed
                    ? "فشل"
                    : liveIrrigation.completed
                      ? liveIrrigation.stopped ? "تم الإيقاف" : "اكتمل التنفيذ"
                      : liveIrrigation.running
                        ? "ينفذ الآن"
                        : liveIrrigation.received
                          ? "ESP32 استلم الأمر"
                          : liveIrrigation.command
                            ? "بانتظار ACK"
                        : "لا يوجد أمر"}
                </strong>
              </div>
              {isAdmin ? (
                <button className="secondary dangerButton" onClick={sendEmergencyStopCommand} disabled={!selectedLandId}>
                  إيقاف فوري
                </button>
              ) : null}
            </div>
            <div className="irrigationProgressTrack">
              <div style={{ width: `${liveIrrigation.progress}%` }} />
            </div>
            <div className="irrigationStages">
              <div className={liveIrrigation.command?.published_at ? "stageDone" : ""}>
                <span>1</span>
                <strong>نشر MQTT</strong>
                <small>{liveIrrigation.command?.published_at ? new Date(liveIrrigation.command.published_at).toLocaleTimeString("ar-IQ") : "بانتظار النشر"}</small>
              </div>
              <div className={liveIrrigation.received ? "stageDone" : ""}>
                <span>2</span>
                <strong>استلام ESP32</strong>
                <small>{liveIrrigation.ackStatus ?? "لا يوجد ACK بعد"}</small>
              </div>
              <div className={liveIrrigation.running || liveIrrigation.completed ? "stageDone" : ""}>
                <span>3</span>
                <strong>فتح الصمام</strong>
                <small>{liveIrrigation.received ? liveIrrigation.relayState : "بانتظار دليل من ESP32"}</small>
              </div>
              <div className={liveIrrigation.completed ? "stageDone" : liveIrrigation.failed ? "stageFailed" : ""}>
                <span>4</span>
                <strong>الإغلاق الآمن</strong>
                <small>
                  {liveIrrigation.completed
                    ? liveIrrigation.stopped ? "تم الإيقاف فوراً" : "تم الإغلاق"
                    : liveIrrigation.failed
                      ? "فشل/رفض"
                      : liveIrrigation.received
                        ? `${liveIrrigation.remaining.toFixed(0)}s متبقية`
                        : "لم يبدأ التنفيذ المؤكد"}
                </small>
              </div>
            </div>
            <div className="liveIrrigationMetrics">
              <div><span>نسبة التنفيذ</span><strong>{liveIrrigation.progress.toFixed(0)}%</strong></div>
              <div><span>الماء المصروف</span><strong>{liveIrrigation.spent.toFixed(2)} L</strong></div>
              <div><span>المستهدف</span><strong>{liveIrrigation.target ? `${liveIrrigation.target.toFixed(2)} L` : "غير محدد"}</strong></div>
              <div><span>الوقت</span><strong>{liveIrrigation.elapsed.toFixed(0)}s / {liveIrrigation.duration.toFixed(0)}s</strong></div>
              <div><span>التدفق</span><strong>{liveIrrigation.flow ? `${liveIrrigation.flow.toFixed(1)} L/min` : "غير معروف"}</strong></div>
              <div><span>آخر قراءة</span><strong>{liveIrrigation.telemetry?.captured_at ? new Date(liveIrrigation.telemetry.captured_at).toLocaleTimeString("ar-IQ") : "لا توجد"}</strong></div>
            </div>
            {liveIrrigation.message ? (
              <div className="pitchBox">
                <span>رسالة ESP32</span>
                <strong>{liveIrrigation.message}</strong>
              </div>
            ) : null}
            {liveIrrigation.history.length ? (
              <details className="advancedActions">
                <summary>سجل ACK لهذا الأمر</summary>
                <div className="ackHistoryList">
                  {liveIrrigation.history.slice(-6).reverse().map((item, index) => (
                    <div key={`${item.status}-${item.received_at}-${index}`}>
                      <strong>{item.status ?? "ack"}</strong>
                      <span>{Number(item.progress_percent ?? 0).toFixed(0)}% / {Number(item.water_spent_liters ?? 0).toFixed(2)} L</span>
                      <small>{item.received_at ? new Date(item.received_at).toLocaleString("ar-IQ") : item.message}</small>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
          <div className="managerMetrics">
            <div><span>تحليلات محفوظة</span><strong>{landOps.summary.analysesCount}</strong></div>
            <div><span>توصيات ري</span><strong>{landOps.summary.recommendationsCount}</strong></div>
            <div><span>صور محفوظة</span><strong>{landOps.summary.imageryCount}</strong></div>
            <div><span>ملاحظات ميدانية</span><strong>{landOps.summary.fieldNotesCount}</strong></div>
            <div><span>خطط AI محفوظة</span><strong>{landOps.summary.actionPlansCount}</strong></div>
            <div><span>قرارات AI محفوظة</span><strong>{landOps.summary.aiDecisionsCount}</strong></div>
            <div><span>أوامر IoT</span><strong>{landOps.summary.commandsCount}</strong></div>
            <div><span>قراءات حساسات</span><strong>{landOps.summary.telemetryCount}</strong></div>
            <div><span>أجهزة فعالة</span><strong>{landOps.summary.activeDevices}/{landOps.summary.devicesCount}</strong></div>
            <div>
              <span>اتصال ESP32</span>
              <strong>
                {landOps.summary.deviceConnectionStatus === "online"
                  ? "متصل الآن"
                  : landOps.summary.deviceConnectionStatus === "offline"
                    ? "غير متصل"
                    : "غير مسجل"}
              </strong>
            </div>
            <div><span>آخر خطر آفات</span><strong>{landOps.summary.latestPestRisk}</strong></div>
            <div><span>آخر ري مقترح</span><strong>{Number(landOps.summary.latestRecommendedLiters).toFixed(1)} L</strong></div>
          </div>
          {isAdmin ? (
          <div className="landAgentPanel">
            <div className="boardHeader">
              <div>
                <h3>Agent العمليات</h3>
                <p>يعامل المنصة كأدوات: يقرأ الأرض، الطقس، الجرد، الخزان، ESP32، ثم يجهز قراراً قابلاً لاعتماد المدير.</p>
              </div>
              <button onClick={runOperationsAgent}>تشغيل Agent</button>
            </div>
            <textarea
              value={agentMessage}
              onChange={(event) => setAgentMessage(event.target.value)}
              placeholder="مثال: افحص الأرض وجهز أمر ري إذا الخزان يكفي والجهاز جاهز"
            />
            <div className="quickQuestionRow">
              {[
                "افحص الأرض وجهز قرار ري إذا الخزان يكفي والجهاز جاهز",
                "هل أقدر أشغل الري الآن؟ لا تجهز أمر إذا الخزان ناقص",
                "شنو الخطوات الناقصة قبل الأتمتة؟",
                "جهز خطة تشغيل آمنة بدون إرسال MQTT"
              ].map((message) => (
                <button className="ghostButton" key={message} onClick={() => setAgentMessage(message)}>
                  {message}
                </button>
              ))}
            </div>
            {agentRun ? (
              <div className="agentResult">
                <div className="planHeader">
                  <div>
                    <h3>{agentRun.agent.agent_name}</h3>
                    <p>{agentRun.agent.summary}</p>
                    <p>مصدر Agent: {agentRun.source === "gemini_agent" ? "Gemini + أدوات المنصة" : "قواعد تشغيلية احتياطية"}</p>
                  </div>
                  <div className="planDecision">
                    <span>{agentRun.agent.decision}</span>
                    <strong>{Number(agentRun.agent.confidence ?? 0).toFixed(2)}</strong>
                  </div>
                </div>
                <div className="demoFlow">
                  {agentRun.agent.tool_trace.map((tool, index) => (
                    <div className="timelineItem" key={`${tool.tool}-${index}`}>
                      <strong>{tool.tool} / {tool.status}</strong>
                      <span>{tool.result}</span>
                    </div>
                  ))}
                </div>
                <div className="readyDemoGrid">
                  <div className="readyDemoPanel">
                    <h3>الأمر المقترح</h3>
                    <div className="codePreview" dir="ltr">
                      <span>Topic: {agentRun.agent.proposed_command.mqtt_topic || "not prepared"}</span>
                      <pre>{JSON.stringify(agentRun.agent.proposed_command.payload, null, 2)}</pre>
                    </div>
                    <div className="actionsRow agentCommandActions">
                      <button
                        onClick={approveAgentCommand}
                        disabled={
                          !agentRun.agent.proposed_command.allowed_to_prepare
                          || Number(agentRun.agent.proposed_command.payload.duration_seconds ?? 0) <= 0
                          || Number(agentRun.agent.proposed_command.payload.duration_seconds ?? 0) > 1800
                        }
                      >
                        اعتماد وإرسال عبر MQTT
                      </button>
                      <span>
                        {Number(agentRun.agent.proposed_command.payload.duration_seconds ?? 0) > 1800
                          ? "المدة أكبر من حد الأمان 1800 ثانية"
                          : agentRun.agent.proposed_command.allowed_to_prepare
                            ? "يمر عبر مراجعة الأمان قبل النشر"
                            : "غير جاهز للإرسال"}
                      </span>
                    </div>
                    <div className="pitchBox">
                      <span>اعتماد المدير</span>
                      <strong>
                        {agentRun.agent.proposed_command.requires_admin_approval
                          ? "يتطلب موافقة Admin قبل أي إرسال MQTT."
                          : "جاهز حسب سياسة الأمان الحالية."}
                      </strong>
                    </div>
                  </div>
                  <div className="readyDemoPanel">
                    <h3>فحوص الأمان والخطوات</h3>
                    <div className="decisionStack">
                      {agentRun.agent.safety_checks.map((check, index) => (
                        <div key={`${check.name}-${index}`}>
                          <span>{check.name} / {check.status}</span>
                          <strong>{check.details}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="demoFlow">
                      {agentRun.agent.next_actions.map((action, index) => (
                        <div className="timelineItem" key={`${action.owner}-${index}`}>
                          <strong>{action.owner} / {action.priority}</strong>
                          <span>{action.action}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {agentRun.agent.missing_data.length ? (
                  <div className="pitchBox">
                    <span>بيانات ناقصة</span>
                    <strong>{agentRun.agent.missing_data.join(" / ")}</strong>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          ) : null}
          {isAdmin ? (
          <div className="landQuestionPanel">
            <div className="boardHeader">
              <div>
                <h3>اسأل AI عن هذه الأرض</h3>
                <p>اكتب سؤالاً عن القرار، الري، الآفات، الأجهزة، أو نقص البيانات، وسيجيب اعتماداً على سجلات الأرض فقط.</p>
              </div>
              <button onClick={askLandQuestion}>اسأل</button>
            </div>
            <textarea
              value={landQuestion}
              onChange={(event) => setLandQuestion(event.target.value)}
              placeholder="مثال: هل أرسل أمر ري الآن؟ ما الدليل؟"
            />
            <div className="quickQuestionRow">
              {[
                "هل أرسل أمر ري الآن؟ وما الدليل؟",
                "ليش القرار الحالي يحتاج مراجعة؟",
                "هل توجد مؤشرات سوسة النخيل الحمراء؟",
                "شنو البيانات الناقصة قبل الأتمتة؟"
              ].map((question) => (
                <button className="ghostButton" key={question} onClick={() => setLandQuestion(question)}>
                  {question}
                </button>
              ))}
            </div>
            {landQuestionAnswer ? (
              <div className="landQuestionAnswer">
                <div className="planHeader">
                  <div>
                    <h3>جواب الأرض</h3>
                    <p>{landQuestionAnswer.answer.answer}</p>
                    <p>مصدر الجواب: {landQuestionAnswer.source === "gemini" ? "Gemini" : "ملخص تشغيلي من بيانات Supabase"}</p>
                  </div>
                  <div className="planDecision">
                    <span>الثقة</span>
                    <strong>{Number(landQuestionAnswer.answer.confidence ?? 0).toFixed(2)}</strong>
                  </div>
                  <button className="secondary" onClick={copyLandQuestionAnswer}>نسخ الجواب</button>
                </div>
                <div className="demoFlow">
                  {landQuestionAnswer.answer.evidence_used.map((item, index) => (
                    <div className="timelineItem" key={`${item.source}-${index}`}>
                      <strong>{item.source}</strong>
                      <span>{item.detail}</span>
                    </div>
                  ))}
                </div>
                <div className="pitchBox">
                  <span>الخطوة التالية</span>
                  <strong>{landQuestionAnswer.answer.recommended_next_step}</strong>
                </div>
                {landQuestionAnswer.answer.missing_data.length ? (
                  <div className="pitchBox">
                    <span>بيانات ناقصة</span>
                    <strong>{landQuestionAnswer.answer.missing_data.join(" / ")}</strong>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          ) : null}
          {workOrders ? (
            <div className="workOrdersPanel">
              <div className="planHeader">
                <div>
                  <h3>{workOrders.workPlan.headline}</h3>
                  <p>{workOrders.workPlan.summary}</p>
                  <p>مصدر الأوامر: {workOrders.source === "ai" ? "Gemini + سجل الأرض" : "قواعد تشغيلية من سجل الأرض"}</p>
                </div>
                <div className="planDecision">
                  <span>أوامر العمل</span>
                  <strong>{workOrders.workPlan.work_orders.length}</strong>
                </div>
              </div>
              <div className="taskGrid">
                {workOrders.workPlan.work_orders.map((task, index) => (
                  <div className="taskCard" key={`${task.title}-${index}`}>
                    <span>{task.owner_role} / {task.priority} / خلال {Number(task.due_in_hours ?? 0).toFixed(0)} ساعة</span>
                    <strong>{task.title}</strong>
                    <p>{task.why}</p>
                    <p>{task.how}</p>
                    <em>{task.success_check}</em>
                    {task.evidence.length ? <small>{task.evidence.join(" / ")}</small> : null}
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>قيمة إدارية</span>
                <strong>{workOrders.workPlan.manager_value}</strong>
              </div>
              {workOrders.saved?.count ? (
                <div className="pitchBox">
                  <span>تم الحفظ</span>
                  <strong>{workOrders.saved.count} أوامر عمل محفوظة كسجل متابعة.</strong>
                </div>
              ) : workOrders.saveError ? (
                <div className="pitchBox">
                  <span>الحفظ غير مفعّل بعد</span>
                  <strong>{workOrders.saveError}</strong>
                </div>
              ) : null}
              {workOrders.workPlan.missing_data.length ? (
                <div className="pitchBox">
                  <span>بيانات ناقصة</span>
                  <strong>{workOrders.workPlan.missing_data.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {impact ? (
            <div className="impactStory">
              <div>
                <span>نضج التشغيل</span>
                <strong>{impact.impact.maturityLabel} ({impact.impact.maturityScore}/{impact.impact.maturityMax})</strong>
              </div>
              <div>
                <span>توفير ماء مقاس من خصم المطر</span>
                <strong>{Number(impact.impact.measuredWaterSavingLiters).toFixed(1)} L</strong>
              </div>
              <div>
                <span>قصة الأثر</span>
                <strong>{impact.impact.story}</strong>
              </div>
            </div>
          ) : null}
          {hardwareReadiness ? (
            <div className="hardwareReadinessPanel">
              <div className="planHeader">
                <div>
                  <h3>{hardwareReadiness.readiness.headline}</h3>
                  <p>{hardwareReadiness.readiness.operator_summary}</p>
                  <p>مصدر الفحص: {hardwareReadiness.source === "gemini" ? "Gemini + Supabase" : "قواعد تشغيلية من بيانات Supabase"}</p>
                </div>
                <div className="planDecision">
                  <span>{hardwareReadiness.readiness.readiness}</span>
                  <strong>{Number(hardwareReadiness.readiness.score ?? 0).toFixed(0)}/100</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>MQTT</span>
                  <strong>{hardwareReadiness.configuration.mqttConfigured ? "مفعّل" : "غير مفعّل"}</strong>
                </div>
                <div>
                  <span>الأجهزة</span>
                  <strong>{hardwareReadiness.evidenceCounts.devices}</strong>
                </div>
                <div>
                  <span>Telemetry</span>
                  <strong>{hardwareReadiness.evidenceCounts.telemetry}</strong>
                </div>
              </div>
              <div className="demoFlow">
                {hardwareReadiness.readiness.checks.map((check, index) => (
                  <div className="timelineItem" key={`${check.name}-${index}`}>
                    <strong>{check.name} / {check.status}</strong>
                    <span>{check.evidence}</span>
                    <small>{check.fix}</small>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>{hardwareReadiness.readiness.safe_demo_action.allowed ? "إجراء تشغيل آمن" : "إجراء التشغيل المقترح"}</span>
                <strong>{hardwareReadiness.readiness.safe_demo_action.action} / {hardwareReadiness.readiness.safe_demo_action.reason}</strong>
              </div>
              <div className="pitchBox">
                <span>قيمة إدارية</span>
                <strong>{hardwareReadiness.readiness.manager_value}</strong>
              </div>
              {hardwareReadiness.readiness.next_steps.length ? (
                <div className="pitchBox">
                  <span>الخطوات التالية</span>
                  <strong>{hardwareReadiness.readiness.next_steps.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {irrigationSchedule ? (
            <div className="irrigationSchedulePanel">
              <div className="planHeader">
                <div>
                  <h3>{irrigationSchedule.schedule.title}</h3>
                  <p>{irrigationSchedule.schedule.summary}</p>
                  <p>مصدر الجدولة: {irrigationSchedule.source === "ai" ? "Gemini + OpenWeather + Supabase" : "قواعد تشغيلية من البيانات عند تعذر Gemini"}</p>
                </div>
                <div className="planDecision">
                  <span>{irrigationSchedule.schedule.mode}</span>
                  <strong>{Number(irrigationSchedule.schedule.confidence ?? 0).toFixed(2)}</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>ماء مقترح خلال 24 ساعة</span>
                  <strong>{Number(irrigationSchedule.schedule.water_budget.liters_next_24h ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>مود الري</span>
                  <strong>{irrigationModeLabel(irrigationSchedule.schedule.water_budget.irrigation_mode ?? irrigationMode)}</strong>
                </div>
                <div>
                  <span>كمية الرية الواحدة</span>
                  <strong>{Number(irrigationSchedule.schedule.water_budget.liters_per_irrigation ?? irrigationSchedule.schedule.water_budget.liters_next_24h ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>الماء القابل للتنفيذ</span>
                  <strong>{Number(irrigationSchedule.schedule.water_budget.executable_liters ?? irrigationSchedule.schedule.water_budget.liters_next_24h ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>ماء الخزان المتاح</span>
                  <strong>{Number(irrigationSchedule.schedule.water_budget.usable_tank_liters ?? irrigationSchedule.schedule.water_budget.tank_available_liters ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>نقص الخزان</span>
                  <strong>{Number(irrigationSchedule.schedule.water_budget.tank_shortage_liters ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>فاصل الري</span>
                  <strong>كل {Number(irrigationSchedule.schedule.water_budget.irrigation_interval_days ?? 1).toFixed(0)} يوم</strong>
                </div>
                <div>
                  <span>المتوسط اليومي</span>
                  <strong>{Number(irrigationSchedule.schedule.water_budget.daily_average_liters ?? irrigationSchedule.schedule.water_budget.liters_next_24h ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>خصم المطر</span>
                  <strong>{Number(irrigationSchedule.schedule.water_budget.rain_deduction_liters ?? 0).toFixed(1)} L</strong>
                </div>
                <div>
                  <span>توصية المصدر</span>
                  <strong>#{irrigationSchedule.schedule.water_budget.source_recommendation_id || "لا يوجد"}</strong>
                </div>
              </div>
              <div className="pitchBox">
                <span>جهاز التنفيذ</span>
                <strong>
                  {deviceUid.trim()
                    ? `سيتم الإرسال إلى ${deviceUid.trim()}`
                    : landOps.recent.devices.find((device) => device.is_active)?.device_uid
                      ? `سيتم استخدام الجهاز الفعّال ${landOps.recent.devices.find((device) => device.is_active)?.device_uid}`
                      : "لا يوجد جهاز فعّال محفوظ. أدخل Device UID أو اربط ESP32 قبل إرسال MQTT."}
                </strong>
              </div>
              <div className="demoFlow">
                {irrigationSchedule.schedule.slots.map((slot) => (
                  <div className="timelineItem" key={`${slot.slot}-${slot.start_after_minutes}`}>
                    <strong>Slot {slot.slot}: بعد {Number(slot.start_after_minutes ?? 0).toFixed(0)} دقيقة / {slot.valve_status}</strong>
                    <span>{Number(slot.duration_seconds ?? 0).toFixed(0)} ثانية / MQTT: {slot.send_mqtt ? "جاهز بعد الموافقة" : "لا ترسل"}</span>
                    <span>{slot.reason}</span>
                    <small>{slot.requires_operator_approval ? "يتطلب موافقة المشغل" : "لا يتطلب موافقة إضافية"}</small>
                    {isAdmin ? (
                      <button
                        className="miniButton"
                        onClick={() => sendIrrigationScheduleSlot(slot)}
                        disabled={!slot.send_mqtt || Number(slot.duration_seconds ?? 0) <= 0}
                      >
                        اعتماد وإرسال MQTT
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="briefGrid">
                <div>
                  <h4>فحوص السلامة</h4>
                  {irrigationSchedule.schedule.safety_checks.map((check, index) => (
                    <div className="timelineItem" key={`${check}-${index}`}>
                      <strong>{check}</strong>
                    </div>
                  ))}
                </div>
                <div>
                  <h4>رسالة المشغل</h4>
                  <div className="timelineItem">
                    <strong>{irrigationSchedule.schedule.operator_message}</strong>
                    <span>{irrigationSchedule.schedule.manager_value}</span>
                  </div>
                </div>
              </div>
              {irrigationSchedule.saved?.scheduleId ? (
                <div className="pitchBox">
                  <span>تم حفظ الجدولة</span>
                  <strong>سجل جدولة رقم {irrigationSchedule.saved.scheduleId}</strong>
                </div>
              ) : irrigationSchedule.saveError ? (
                <div className="pitchBox">
                  <span>حفظ الجدولة غير مفعل بعد</span>
                  <strong>{irrigationSchedule.saveError}</strong>
                </div>
              ) : null}
              {irrigationSchedule.schedule.missing_data.length ? (
                <div className="pitchBox">
                  <span>بيانات ناقصة لتحسين الجدولة</span>
                  <strong>{irrigationSchedule.schedule.missing_data.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {unifiedDecision ? (
            <div className="unifiedDecisionPanel">
              <div className="planHeader">
                <div>
                  <h3>{unifiedDecision.decision.headline}</h3>
                  <p>{unifiedDecision.decision.why}</p>
                  {unifiedDecision.decisionSource ? (
                    <p>
                      مصدر القرار: {unifiedDecision.decisionSource === "gemini" ? "Gemini" : "ترتيب تشغيلي من البيانات عند تعذر Gemini"}
                    </p>
                  ) : null}
                </div>
                <div className="planDecision">
                  <span>{unifiedDecision.decision.decision} / {unifiedDecision.decision.risk_level}</span>
                  <strong>{Number(unifiedDecision.decision.confidence ?? 0).toFixed(2)}</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>الأتمتة</span>
                  <strong>{unifiedDecision.decision.automation.allowed ? "مسموحة" : "تحتاج موافقة"}</strong>
                  <p>{unifiedDecision.decision.automation.reason}</p>
                </div>
                <div>
                  <span>مدة مقترحة</span>
                  <strong>{Number(unifiedDecision.decision.automation.suggested_duration_seconds ?? 0).toFixed(0)} ثانية</strong>
                </div>
                <div>
                  <span>أضعف حلقة</span>
                  <strong>{unifiedDecision.decision.manager_view.weakest_link}</strong>
                </div>
              </div>
              <div className="demoFlow">
                {unifiedDecision.decision.farmer_next_actions.map((action, index) => (
                  <div className="timelineItem" key={`${action.title}-${index}`}>
                    <strong>{action.title} / {action.priority}</strong>
                    <span>{action.time_window}</span>
                    <span>{action.success_check}</span>
                  </div>
                ))}
              </div>
              <div className="demoFlow">
                {unifiedDecision.decision.evidence_used.slice(0, 6).map((item, index) => (
                  <div className="timelineItem" key={`${item.source}-${index}`}>
                    <strong>{item.source} / {item.strength}</strong>
                    <span>{item.finding}</span>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>ملخص إداري</span>
                <strong>{unifiedDecision.decision.manager_view.judge_story}</strong>
              </div>
              <div className="pitchBox">
                <span>قيمة المشروع</span>
                <strong>{unifiedDecision.decision.manager_view.business_value}</strong>
              </div>
              {unifiedDecision.decision.missing_data.length ? (
                <div className="pitchBox">
                  <span>بيانات ناقصة لتحسين القرار</span>
                  <strong>{unifiedDecision.decision.missing_data.join(" / ")}</strong>
                </div>
              ) : null}
              {unifiedDecision.saved?.decisionId ? (
                <div className="pitchBox">
                  <span>تم حفظ القرار</span>
                  <strong>سجل تدقيق رقم {unifiedDecision.saved.decisionId}</strong>
                </div>
              ) : unifiedDecision.saveError ? (
                <div className="pitchBox">
                  <span>حفظ القرار غير مفعل بعد</span>
                  <strong>{unifiedDecision.saveError}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {weatherRisk ? (
            <div className="weatherRiskPanel">
              <div className="planHeader">
                <div>
                  <h3>{weatherRisk.risk.headline}</h3>
                  <p>{weatherRisk.risk.why}</p>
                  <p>مصدر التحليل: {weatherRisk.source === "gemini" ? "Gemini + OpenWeather" : "OpenWeather + قواعد تشغيلية عند تعذر Gemini"}</p>
                </div>
                <div className="planDecision">
                  <span>{weatherRisk.risk.irrigation_adjustment} / {weatherRisk.risk.weather_risk}</span>
                  <strong>{Number(weatherRisk.risk.confidence ?? 0).toFixed(2)}</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>المطر المتوقع</span>
                  <strong>{Number(weatherRisk.risk.rain_effect.forecast_rain_mm ?? 0).toFixed(1)} mm</strong>
                  <p>{weatherRisk.risk.rain_effect.recommendation}</p>
                </div>
                <div>
                  <span>حالة الحساسات</span>
                  <strong>{weatherRisk.telemetryAvailable ? "متوفرة" : "غير متوفرة"}</strong>
                  {weatherRisk.telemetryError ? <p>{weatherRisk.telemetryError}</p> : null}
                </div>
                <div>
                  <span>قيمة إدارية</span>
                  <strong>{weatherRisk.risk.manager_value}</strong>
                </div>
              </div>
              <div className="demoFlow">
                {weatherRisk.risk.heat_or_humidity_watch.map((item, index) => (
                  <div className="timelineItem" key={`${item.signal}-${index}`}>
                    <strong>{item.signal} / {item.risk}</strong>
                    <span>{item.action}</span>
                  </div>
                ))}
              </div>
              <div className="demoFlow">
                {weatherRisk.risk.farmer_actions.map((action, index) => (
                  <div className="timelineItem" key={`${action.title}-${index}`}>
                    <strong>{action.title} / {action.priority}</strong>
                    <span>{action.time_window}</span>
                  </div>
                ))}
              </div>
              {weatherRisk.risk.missing_data.length ? (
                <div className="pitchBox">
                  <span>بيانات ناقصة لتحسين تنبيه الطقس</span>
                  <strong>{weatherRisk.risk.missing_data.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {pestResponse ? (
            <div className="pestResponsePanel">
              <div className="planHeader">
                <div>
                  <h3>{pestResponse.response.headline}</h3>
                  <p>مصدر الخطة: {pestResponse.source === "gemini" ? "Gemini" : "قواعد تشغيلية من بيانات Supabase"}</p>
                </div>
                <div className="planDecision">
                  <span>خطر الآفات</span>
                  <strong>{pestResponse.response.pest_risk}</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>مراقبة سوسة النخيل</span>
                  <strong>{pestResponse.response.red_palm_weevil_watch.suspected ? "مشتبه" : "غير مؤكد"}</strong>
                  <p>ثقة {Number(pestResponse.response.red_palm_weevil_watch.confidence ?? 0).toFixed(2)}</p>
                </div>
                <div>
                  <span>التصعيد</span>
                  <strong>{pestResponse.response.escalation.needed ? "مطلوب" : "غير مطلوب حالياً"}</strong>
                  <p>{pestResponse.response.escalation.when} / {pestResponse.response.escalation.who}</p>
                </div>
                <div>
                  <span>تحذير الري</span>
                  <strong>{pestResponse.response.irrigation_caution}</strong>
                </div>
              </div>
              <div className="demoFlow">
                {pestResponse.response.immediate_actions.map((action, index) => (
                  <div className="timelineItem" key={`${action.title}-${index}`}>
                    <strong>{action.title} / {action.priority} / {action.owner}</strong>
                    <span>{action.how}</span>
                    <span>{action.done_when}</span>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>صور مطلوبة كدليل</span>
                <strong>{pestResponse.response.photo_evidence_needed.join(" / ")}</strong>
              </div>
              <div className="pitchBox">
                <span>قيمة إدارية</span>
                <strong>{pestResponse.response.manager_value}</strong>
              </div>
              {pestResponse.response.missing_data.length ? (
                <div className="pitchBox">
                  <span>بيانات ناقصة لخطة الآفات</span>
                  <strong>{pestResponse.response.missing_data.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {operatorChecklist ? (
            <div className="operatorChecklistPanel">
              <div className="planHeader">
                <div>
                  <h3>{operatorChecklist.checklist.title}</h3>
                  <p>{operatorChecklist.checklist.operator_summary}</p>
                  <p>مصدر القائمة: {operatorChecklist.source === "gemini" ? "Gemini" : "قواعد تشغيلية من بيانات Supabase"}</p>
                </div>
                <div className="checklistActions">
                  <div className="planDecision">
                    <span>أولوية التنفيذ</span>
                    <strong>{operatorChecklist.checklist.overall_priority}</strong>
                  </div>
                  <button className="secondary" onClick={copyOperatorChecklist}>نسخ المهام</button>
                </div>
              </div>
              <div className="taskGrid">
                {operatorChecklist.checklist.checklist.map((task) => (
                  <div className="taskCard" key={`${task.step}-${task.task}`}>
                    <span>خطوة {task.step} / {task.owner} / {task.priority}</span>
                    <strong>{task.task}</strong>
                    <p>{task.time_window}</p>
                    <p>{task.evidence}</p>
                    <em>{task.done_when}</em>
                  </div>
                ))}
              </div>
              {operatorChecklist.checklist.do_not_do.length ? (
                <div className="pitchBox">
                  <span>لا تفعل</span>
                  <strong>{operatorChecklist.checklist.do_not_do.join(" / ")}</strong>
                </div>
              ) : null}
              <div className="pitchBox">
                <span>ملاحظة مدير المشروع</span>
                <strong>{operatorChecklist.checklist.manager_note}</strong>
              </div>
              {operatorChecklist.checklist.missing_data.length ? (
                <div className="pitchBox">
                  <span>بيانات ناقصة لإغلاق المهام</span>
                  <strong>{operatorChecklist.checklist.missing_data.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {evidenceReport ? (
            <div className="evidenceReport">
              <div className="planHeader">
                <div>
                  <h3>{evidenceReport.report.title}</h3>
                  <p>{evidenceReport.report.executive_summary}</p>
                </div>
                <div className="planDecision">
                  <span>قوة الدليل</span>
                  <strong>{Number(evidenceReport.report.evidence_score ?? 0).toFixed(0)}/100</strong>
                </div>
              </div>
              <div className="reportColumns">
                <div>
                  <span>القرار الحالي</span>
                  <strong>{evidenceReport.report.current_decision.decision}</strong>
                  <p>{evidenceReport.report.current_decision.reason}</p>
                </div>
                <div>
                  <span>الخطوة التالية</span>
                  <strong>{evidenceReport.report.next_best_step}</strong>
                </div>
                <div>
                  <span>أعداد الأدلة</span>
                  <strong>
                    صور {evidenceReport.evidenceCounts.imagery} / تحليلات {evidenceReport.evidenceCounts.analyses} / أوامر {evidenceReport.evidenceCounts.commands}
                  </strong>
                </div>
              </div>
              <div className="demoFlow">
                {evidenceReport.report.proof_points.map((point, index) => (
                  <div className="timelineItem" key={`${point.claim}-${index}`}>
                    <strong>{point.claim} / {point.strength}</strong>
                    <span>{point.evidence}</span>
                  </div>
                ))}
              </div>
              <div className="demoFlow">
                {evidenceReport.report.timeline.slice(0, 4).map((item, index) => (
                  <div className="timelineItem" key={`${item.event}-${index}`}>
                    <strong>{item.source} / {item.event}</strong>
                    <span>{item.timestamp}</span>
                    <span>{item.why_it_matters}</span>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>ملخص التقرير</span>
                <strong>{evidenceReport.report.judge_demo_script.join(" / ")}</strong>
              </div>
              {evidenceReport.report.missing_evidence.length ? (
                <div className="pitchBox">
                  <span>أدلة ناقصة قبل الاعتماد</span>
                  <strong>{evidenceReport.report.missing_evidence.join(" / ")}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="opsTimeline">
            <div>
              <h3>آخر توصيات الري</h3>
              {landOps.recent.recommendations.length ? (
                landOps.recent.recommendations.map((recommendation) => (
                  <div className="timelineItem" key={recommendation.id}>
                    <strong>{Number(recommendation.total_liters_per_day).toFixed(1)} L / {recommendation.recommended_duration_seconds}s</strong>
                    <span>{recommendation.status} / {new Date(recommendation.created_at).toLocaleString("ar-IQ")}</span>
                    {isAdmin ? (
                      <button
                        className="miniButton"
                        onClick={() => sendIotCommand(recommendation)}
                        disabled={(!deviceUid && !landOps.recent.devices.some((device) => device.is_active)) || recommendation.recommended_duration_seconds <= 0}
                      >
                        إرسال هذه التوصية للـ ESP32
                      </button>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="mutedText">لا توجد توصيات ري محفوظة لهذه الأرض بعد.</p>
              )}
            </div>
            <div>
              <h3>آخر تحليلات AI</h3>
              {landOps.recent.analyses.length ? (
                landOps.recent.analyses.map((analysis) => (
                  <div className="timelineItem" key={analysis.id}>
                    <strong>ثقة {Number(analysis.confidence ?? 0).toFixed(2)}</strong>
                    <span>{new Date(analysis.created_at).toLocaleString("ar-IQ")}</span>
                  </div>
                ))
              ) : (
                <p className="mutedText">ارفع صورة للهاتف أو الدرون ثم شغّل التحليل لبدء السجل.</p>
              )}
            </div>
            <div>
              <h3>آخر صور محفوظة</h3>
              {landOps.recent.imagery.length ? (
                landOps.recent.imagery.map((item) => (
                  <div className={`timelineItem imageryItem ${item.signed_url ? "" : "imageryItemNoThumb"}`} key={item.id}>
                    {item.signed_url ? (
                      <img
                        src={item.signed_url}
                        alt={item.metadata?.originalName ?? "صورة أرض محفوظة"}
                        className="imageryThumb"
                      />
                    ) : null}
                    <div>
                      <strong>{item.metadata?.originalName ?? item.image_url}</strong>
                      <span>{item.source} / {new Date(item.captured_at ?? item.created_at).toLocaleString("ar-IQ")}</span>
                    </div>
                  </div>
                ))
              ) : (
                <p className="mutedText">لا توجد صور مؤرشفة لهذه الأرض بعد. اختر الأرض ثم ارفع صورة حقيقية للتحليل.</p>
              )}
            </div>
            <div>
              <h3>آخر أوامر IoT</h3>
              {landOps.recent.commands.length ? (
                landOps.recent.commands.map((command) => (
                  <div className="timelineItem" key={command.id}>
                    <strong>{command.status} / {command.payload?.duration_seconds ?? 0}s</strong>
                    <span>
                      {command.payload?.device_uid ?? "ESP32"} / {new Date(command.published_at ?? command.created_at).toLocaleString("ar-IQ")}
                    </span>
                    {command.payload?.safety?.ai_review ? (
                      <span>
                        مراجعة السلامة بالذكاء الاصطناعي: {command.payload.safety.ai_review.decision} / {command.payload.safety.ai_review.risk_level} - {command.payload.safety.ai_review.reason}
                      </span>
                    ) : null}
                    {command.ack_payload?.status ? (
                      <span>
                        تأكيد ESP32: {command.ack_payload.status} / relay {command.ack_payload.relay_state ?? "?"} / {command.ack_payload.duration_seconds ?? 0}s
                      </span>
                    ) : null}
                    {command.ack_payload?.error || command.ack_payload?.safety_review?.operator_message ? (
                      <span>
                        {command.ack_payload.safety_review?.operator_message ?? command.ack_payload.error}
                      </span>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="mutedText">لا توجد أوامر IoT مسجلة بعد. أرسل توصية ري محفوظة للجهاز لبدء سجل التنفيذ.</p>
              )}
            </div>
            <div>
              <h3>آخر قراءات ESP32</h3>
              {landOps.recent.devices.length ? (
                <div className="timelineItem">
                  <strong>
                    {landOps.summary.deviceConnectionStatus === "online"
                      ? "ESP32 متصل ويرسل بيانات"
                      : "ESP32 غير متصل حالياً"}
                  </strong>
                  <span>
                    {landOps.recent.devices.map((device) => {
                      const lastSeen = device.latest_seen_at ?? device.last_seen_at;
                      return `${device.device_uid}: ${device.connection_status === "online" ? "متصل" : "غير متصل"}${lastSeen ? ` / آخر ظهور ${new Date(lastSeen).toLocaleString("ar-IQ")}` : " / لا يوجد ظهور محفوظ"}`;
                    }).join(" / ")}
                  </span>
                </div>
              ) : (
                <div className="timelineItem">
                  <strong>لا يوجد ESP32 مسجل لهذه الأرض</strong>
                  <span>استخدم زر تجهيز ESP32 بعد اختيار الأرض حتى يظهر الجهاز هنا وتبدأ مراقبة الاتصال.</span>
                </div>
              )}
              {landOps.recent.telemetry.length ? (
                landOps.recent.telemetry.map((reading) => (
                  <div className="timelineItem" key={reading.id}>
                    {reading.is_test_mode ? (
                      <>
                        <strong>اختبار اتصال ESP32 / صمام {reading.valve_state}</strong>
                        <span>{reading.device_uid} / لا توجد حساسات مركبة حالياً</span>
                        <span>
                          تدفق {reading.flow_liters_per_minute ?? 0} L/min / بطارية {reading.battery_percent ?? "?"}% / {new Date(reading.captured_at).toLocaleString("ar-IQ")}
                        </span>
                        <small>الجهاز متصل ويرسل heartbeat، لكن لا يوجد حساس خزان أو رطوبة مركب.</small>
                      </>
                    ) : (
                      <>
                    <strong>
                      رطوبة {reading.soil_moisture_percent ?? "?"}% / صمام {reading.valve_state}
                    </strong>
                    <span>
                      {reading.device_uid} / حرارة {reading.temperature_c ?? "?"}°C / رطوبة جو {reading.humidity_percent ?? "?"}%
                    </span>
                    <span>
                      تدفق {reading.flow_liters_per_minute ?? 0} L/min / بطارية {reading.battery_percent ?? "?"}% / {new Date(reading.captured_at).toLocaleString("ar-IQ")}
                    </span>
                    {reading.tank ? (
                      <span>
                        خزان {Number(reading.tank.available_liters ?? 0).toFixed(1)} L
                        {reading.tank.level_percent !== null && reading.tank.level_percent !== undefined
                          ? ` / ${Number(reading.tank.level_percent).toFixed(0)}%`
                          : ""}
                        {reading.tank.sensor_source ? ` / ${reading.tank.sensor_source}` : ""}
                      </span>
                    ) : (
                      <small>لا توجد قراءة مستوى خزان في هذه telemetry.</small>
                    )}
                      </>
                    )}
                  </div>
                ))
              ) : (
                <p className="mutedText">لا توجد قراءات حساسات محفوظة بعد. عند ربط ESP32 يمكنه إرسال رطوبة التربة وحالة الصمام لهذا السجل.</p>
              )}
            </div>
            {sensorInsight ? (
              <div className="sensorInsightPanel">
                <h3>{sensorInsight.insight.headline}</h3>
                <div className="timelineItem">
                  <strong>{sensorInsight.insight.irrigation_decision} / ثقة {Number(sensorInsight.insight.sensor_confidence ?? 0).toFixed(2)}</strong>
                  <span>{sensorInsight.insight.decision_reason}</span>
                  {!sensorInsight.telemetryAvailable && sensorInsight.telemetryError ? (
                    <span>{sensorInsight.telemetryError}</span>
                  ) : null}
                </div>
                {sensorInsight.insight.anomaly_watch.map((item, index) => (
                  <div className="timelineItem" key={`${item.signal}-${index}`}>
                    <strong>{item.signal} / {item.risk}</strong>
                    <span>{item.evidence}</span>
                    <span>{item.next_check}</span>
                  </div>
                ))}
                <div className="pitchBox">
                  <span>قيمة إدارية</span>
                  <strong>{sensorInsight.insight.manager_value}</strong>
                </div>
              </div>
            ) : null}
            <div>
              <h3>آخر الملاحظات الميدانية</h3>
              {landOps.recent.notes.length ? (
                landOps.recent.notes.map((note) => (
                  <div className="timelineItem" key={note.id}>
                    <strong>{note.note}</strong>
                    <span>{note.triage_json?.triage_summary ?? "تشخيص محفوظ"} / {new Date(note.created_at).toLocaleString("ar-IQ")}</span>
                  </div>
                ))
              ) : (
                <p className="mutedText">لا توجد ملاحظات ميدانية محفوظة لهذه الأرض بعد.</p>
              )}
            </div>
            <div>
              <h3>خطط AI محفوظة</h3>
              {landOps.recent.plans.length ? (
                landOps.recent.plans.map((plan) => (
                  <div className="timelineItem" key={plan.id}>
                    <strong>{plan.plan_json?.plan_title ?? "خطة تنفيذ AI"}</strong>
                    <span>{plan.plan_json?.decision ?? plan.status} / {new Date(plan.created_at).toLocaleString("ar-IQ")}</span>
                  </div>
                ))
              ) : (
                <p className="mutedText">اضغط خطة تنفيذ AI لحفظ أول خطة تشغيلية.</p>
              )}
            </div>
            <div>
              <h3>قرارات AI محفوظة</h3>
              {landOps.recent.decisions.length ? (
                landOps.recent.decisions.map((decision) => (
                  <div className="timelineItem" key={decision.id}>
                    <strong>{decision.decision_json?.headline ?? "قرار AI موحد"}</strong>
                    <span>
                      {decision.decision_json?.decision ?? decision.status}
                      {" / "}
                      خطر {decision.decision_json?.risk_level ?? "unknown"}
                      {" / "}
                      ثقة {Number(decision.decision_json?.confidence ?? 0).toFixed(2)}
                    </span>
                    <span>{new Date(decision.created_at).toLocaleString("ar-IQ")}</span>
                  </div>
                ))
              ) : (
                <p className="mutedText">اضغط قرار AI موحد لحفظ أول قرار قابل للتدقيق لهذه الأرض.</p>
              )}
            </div>
          </div>
          {actionPlan ? (
            <div className="actionPlan">
              <div className="planHeader">
                <div>
                  <h3>{actionPlan.plan.plan_title}</h3>
                  <p>{actionPlan.plan.decision_reason}</p>
                </div>
                <div className="planDecision">
                  <span>قرار AI</span>
                  <strong>{actionPlan.plan.decision}</strong>
                </div>
              </div>
              <div className="managerMetrics">
                <div><span>توفير ماء متوقع</span><strong>{Number(actionPlan.plan.expected_impact.water_saving_liters).toFixed(0)} L</strong></div>
                <div><span>خفض المخاطر</span><strong>{actionPlan.plan.expected_impact.risk_reduction}</strong></div>
                <div><span>قيمة إدارية</span><strong>{actionPlan.plan.expected_impact.manager_value}</strong></div>
              </div>
              <div className="taskGrid">
                {actionPlan.plan.tasks.map((task, index) => (
                  <div className="taskCard" key={`${task.day}-${task.title}-${index}`}>
                    <span>اليوم {task.day} / {task.owner} / {task.priority}</span>
                    <strong>{task.title}</strong>
                    <p>{task.evidence}</p>
                    <em>{task.success_metric}</em>
                  </div>
                ))}
              </div>
              <div className="pitchBox">
                <span>نقاط إدارية</span>
                <strong>{actionPlan.plan.demo_talking_points.join(" / ")}</strong>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {advisory && activeSection === "field" ? (
        <section className="aiAdvisor">
          <div className="advisorScore">
            <span>جاهزية الحقل</span>
            <strong>{advisory.advisory.field_readiness_score}/100</strong>
          </div>
          <div>
            <h2>مستشار الذكاء الاصطناعي</h2>
            <p>{advisory.advisory.executive_summary}</p>
            <div className="advisorGrid">
              {advisory.advisory.priority_actions.map((action, index) => (
                <div className="advisorCard" key={`${action.title}-${index}`}>
                  <span>{action.urgency} / {action.impact}</span>
                  <strong>{action.title}</strong>
                  <p>{action.reason}</p>
                </div>
              ))}
            </div>
            <div className="pitchBox">
              <span>رؤية المدير</span>
              <strong>{advisory.advisory.project_manager_view.judge_pitch}</strong>
            </div>
          </div>
        </section>
      ) : null}

      {result && activeSection === "field" ? (
        <section className="results">
          <div className="metric">
            <span>المتوسط اليومي للماء</span>
            <strong>{result.irrigation.totalLitersPerDay.toFixed(1)} L</strong>
          </div>
          <div className="metric">
            <span>كمية الرية الواحدة</span>
            <strong>{Number(result.irrigation.totalLitersPerIrrigation ?? result.irrigation.totalLitersPerDay).toFixed(1)} L</strong>
          </div>
          <div className="metric">
            <span>مود الري</span>
            <strong>{irrigationModeLabel(result.irrigation.irrigationMode ?? irrigationMode)}</strong>
            <small>{result.irrigation.irrigationModeReason ?? irrigationModeDescription(result.irrigation.irrigationMode ?? irrigationMode)}</small>
          </div>
          <div className="metric">
            <span>نسبة تطبيق المود</span>
            <strong>{Number(result.irrigation.waterSavingPercent ?? 100).toFixed(0)}%</strong>
            {result.irrigation.rawTotalLitersPerIrrigation ? (
              <small>الاحتياج الخام {Number(result.irrigation.rawTotalLitersPerIrrigation).toFixed(1)} L</small>
            ) : null}
          </div>
          <div className="metric">
            <span>ينفذ من الخزان</span>
            <strong>{Number(result.irrigation.executableLiters ?? result.irrigation.totalLitersPerIrrigation ?? result.irrigation.totalLitersPerDay).toFixed(1)} L</strong>
          </div>
          <div className="metric">
            <span>نقص الخزان</span>
            <strong>{Number(result.irrigation.tankShortageLiters ?? 0).toFixed(1)} L</strong>
          </div>
          <div className="metric">
            <span>فاصل الري</span>
            <strong>كل {Number(result.irrigation.irrigationIntervalDays ?? 1).toFixed(0)} يوم</strong>
          </div>
          <div className="metric">
            <span>خصم المطر</span>
            <strong>{result.irrigation.rainDeductionLiters.toFixed(1)} L</strong>
          </div>
          <div className="metric">
            <span>رطوبة التربة</span>
            <strong>
              {result.irrigation.soilMoisturePercent !== null && result.irrigation.soilMoisturePercent !== undefined
                ? `${Number(result.irrigation.soilMoisturePercent).toFixed(0)}%`
                : "غير متاحة"}
            </strong>
            <small>آخر قراءة ESP32 تدخل مباشرة في حساب الري.</small>
          </div>
          <div className="metric">
            <span>خصم الرطوبة</span>
            <strong>{Number(result.irrigation.soilMoistureDeductionLiters ?? 0).toFixed(1)} L</strong>
            <small>عامل الحساس {Number((result.irrigation.soilMoistureAdjustmentFactor ?? 1) * 100).toFixed(0)}%.</small>
          </div>
          <div className="metric">
            <span>مدة الرية</span>
            <strong>{Number(result.irrigation.recommendedIrrigationDurationSeconds ?? result.irrigation.recommendedDurationSeconds).toFixed(0)}s</strong>
          </div>
          <div className="metric">
            <span>خطر الآفات</span>
            <strong>{result.analysis.pests?.risk_level ?? "unknown"}</strong>
          </div>
        </section>
      ) : null}

      {result && activeSection === "field" ? (
        <section className="analysisBrief">
          <div className="planHeader">
            <div>
              <h2>ملخص تحليل الصورة بالذكاء الاصطناعي</h2>
              <p>
                ثقة التحليل {Number(result.analysis.overall_confidence ?? 0).toFixed(2)}
                {result.analysis.requires_human_review ? " / يحتاج مراجعة بشرية قبل القرار النهائي" : " / مناسب كدليل أولي للتشغيل"}
              </p>
            </div>
            <div className="planDecision">
              <span>جودة الصورة</span>
              <strong>{Number(result.analysis.image_quality?.score ?? 0).toFixed(0)}/100</strong>
            </div>
          </div>
          {result.analysis.image_quality?.limitations?.length ? (
            <div className="pitchBox">
              <span>ملاحظات لتحسين الصورة القادمة</span>
              <strong>{result.analysis.image_quality.limitations.join(" / ")}</strong>
            </div>
          ) : null}
          <div className="analysisGrid">
            <div>
              <h3>النباتات المرصودة</h3>
              {result.analysis.plants?.length ? (
                result.analysis.plants.map((plant, index) => (
                  <div className="timelineItem" key={`${plant.name}-${index}`}>
                    <strong>{plant.name} / عدد {plant.count}</strong>
                    <span>مرحلة {plant.growth_stage ?? "unknown"} / ثقة العد {Number(plant.count_confidence ?? 0).toFixed(2)}</span>
                    <span>{plant.notes}</span>
                  </div>
                ))
              ) : (
                <p className="mutedText">لم يتم رصد نباتات واضحة في الصورة. التقط صورة أقرب أو أوضح للمحصول.</p>
              )}
            </div>
            <div>
              <h3>مراقبة الآفات</h3>
              <div className="timelineItem">
                <strong>الخطر العام: {result.analysis.pests?.risk_level ?? "unknown"}</strong>
                <span>{result.analysis.pests?.detected ? "تم رصد مؤشرات آفات." : "لا توجد مؤشرات آفات مؤكدة في الصورة."}</span>
              </div>
              {result.analysis.pests?.suspected_pests?.map((pest, index) => (
                <div className="timelineItem" key={`${pest.name}-${index}`}>
                  <strong>{pest.name} / ثقة {Number(pest.confidence ?? 0).toFixed(2)}</strong>
                  <span>{pest.evidence.join(" / ")}</span>
                </div>
              ))}
            </div>
            <div>
              <h3>سوسة النخيل الحمراء</h3>
              <div className="timelineItem">
                <strong>
                  {result.analysis.pests?.red_palm_weevil_indicators?.detected ? "مؤشرات موجودة" : "لا توجد مؤشرات واضحة"}
                  {" / "}
                  ثقة {Number(result.analysis.pests?.red_palm_weevil_indicators?.confidence ?? 0).toFixed(2)}
                </strong>
                <span>
                  {result.analysis.pests?.red_palm_weevil_indicators?.evidence?.length
                    ? result.analysis.pests.red_palm_weevil_indicators.evidence.join(" / ")
                    : "يفضل تصوير جذع النخلة، منطقة التاج، وأي ثقوب أو إفرازات بصورة قريبة."}
                </span>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className={`workGrid ${activeSection === "settings" && currentProfile?.role === "admin" ? "" : "sectionHidden"}`}>
        <div className="panel">
          <h2>الأراضي المسجلة</h2>
          {lands.length ? (
            <div className="landList">
              {lands.map((land) => (
                <div className="landItem" key={land.id}>
                  <strong>{land.name}</strong>
                  <span>{land.crop_hint ?? "بدون محصول"} / {Number(land.area_m2).toFixed(1)} م2</span>
                  <div className="itemActions">
                    <button className="miniButton" onClick={() => useLand(land)}>استخدمها للتحليل</button>
                    <button className="miniButton danger" onClick={() => deleteLand(land.id)}>حذف</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mutedText">لا توجد أراض محفوظة أو لم يتم تطبيق سكيمة قاعدة البيانات بعد.</p>
          )}
        </div>

        <div className="panel">
          <div className="panelHeaderRow">
            <h2>حالة الربط</h2>
            <button className="miniButton" onClick={runSetupDoctor}>فحص الإعداد</button>
          </div>
          {health ? (
            <div className="checks">
              {Object.entries(health.configured).map(([key, ready]) => (
                <div className="check" key={key}>
                  <span>{key}</span>
                  <strong className={ready ? "ready" : "missing"}>
                    {ready ? "جاهز" : "ناقص"}
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="mutedText">جاري فحص الإعداد...</p>
          )}
          {setupDoctor ? (
            <div className="setupDoctor">
              <div className="setupScore">
                <span>جاهزية الإعداد</span>
                <strong>{setupDoctor.score}/100</strong>
              </div>
              {setupDoctor.missing.length ? (
                <div className="setupMissing">
                  {setupDoctor.missing.slice(0, 6).map((item) => (
                    <div className="timelineItem" key={`${item.type}-${item.name}`}>
                      <strong>{item.type}: {item.name}</strong>
                      <span>{item.fix}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mutedText">كل إعدادات التشغيل الأساسية جاهزة.</p>
              )}
            </div>
          ) : null}
        </div>
      </section>

      {result && activeSection === "field" ? (
        <section className="panel full">
          <h2>نتيجة Gemini الحقيقية</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      ) : null}
        </div>
      </div>
    </main>
  );
}
