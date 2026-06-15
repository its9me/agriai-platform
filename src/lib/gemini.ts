import { GoogleGenerativeAI } from "@google/generative-ai";

let geminiKeyCursor = 0;

export function getGeminiApiKeys() {
  const keys = [
    ...(process.env.GEMINI_API_KEYS ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2
  ].filter((key): key is string => Boolean(key));

  const uniqueKeys = [...new Set(keys)];
  if (!uniqueKeys.length) {
    throw new Error("Missing required environment variable: GEMINI_API_KEY");
  }

  return uniqueKeys;
}

export function getGeminiKeyCount() {
  return getGeminiApiKeys().length;
}

function getGeminiApiKey() {
  const keys = getGeminiApiKeys();
  const key = keys[geminiKeyCursor % keys.length];
  geminiKeyCursor += 1;
  return key;
}

export const AGRI_ANALYSIS_SYSTEM_PROMPT = `
You are an agricultural vision analysis engine for a precision irrigation platform.

Return valid JSON only. Do not wrap the response in markdown.

Analyze the provided farm image and identify visible crops, plant counts when visually supported,
and pest indicators. Pay special attention to red palm weevil indicators:
bore holes, oozing fluids, sawdust-like frass, chewed palm fibers, crown wilting, and trunk damage.

If sensorContext is provided, treat soil_moisture_percent as field evidence that is stronger than visual
soil appearance. Do not recommend or imply extra irrigation from image dryness if soil moisture is already
high. Mention sensor-supported uncertainty or caution in notes when relevant.

Do not invent invisible findings. If evidence is weak, lower confidence and require human review.

Required JSON:
{
  "plants": [
    {
      "name": "string",
      "count": 0,
      "count_confidence": 0,
      "growth_stage": "seedling|vegetative|flowering|fruiting|mature|unknown",
      "notes": "string"
    }
  ],
  "pests": {
    "detected": false,
    "risk_level": "none|low|medium|high",
    "suspected_pests": [
      {
        "name": "string",
        "evidence": ["string"],
        "confidence": 0
      }
    ],
    "red_palm_weevil_indicators": {
      "detected": false,
      "evidence": ["string"],
      "confidence": 0
    }
  },
  "image_quality": {
    "score": 0,
    "limitations": ["string"]
  },
  "overall_confidence": 0,
  "requires_human_review": false
}
`;

const POTTED_PLANT_ANALYSIS_SYSTEM_PROMPT = `
You are an agricultural computer-vision engine for small potted plants and container irrigation.

Return valid JSON only. Do not wrap the response in markdown.

Analyze the image as a single container/potted-plant irrigation target. Estimate only what is visually supported.
If there is no ruler/reference object, provide realistic ranges and lower confidence. Do not invent exact dimensions.
The goal is to help a real low-cost irrigation system decide a safe first watering amount for one plant/pot.

If sensorContext is provided, treat soil_moisture_percent as authoritative for current watering safety.
When soil moisture is high, recommend waiting or near-zero watering even if the soil surface looks dry.
When soil moisture is low, explain that the recommendation is supported by the sensor.
Do not use outdoor forecast or Open-Meteo soil moisture for potted/indoor plants; many are inside homes
or stores, so only ESP32/local sensor readings can override the image-based estimate.

All user-facing string values must be in Arabic. Keep JSON keys in English exactly as required.

Required JSON:
{
  "plant": {
    "name": "string",
    "arabic_name": "string",
    "growth_stage": "seedling|vegetative|flowering|fruiting|mature|unknown",
    "estimated_height_cm": { "min": 0, "max": 0, "confidence": 0 },
    "canopy_width_cm": { "min": 0, "max": 0, "confidence": 0 },
    "health_status": "healthy|mild_stress|stressed|unknown",
    "visible_stress_signs": ["string"]
  },
  "container": {
    "type": "pot|bag|bed|unknown",
    "estimated_top_diameter_cm": { "min": 0, "max": 0, "confidence": 0 },
    "estimated_depth_cm": { "min": 0, "max": 0, "confidence": 0 },
    "estimated_volume_liters": { "min": 0, "max": 0, "confidence": 0 },
    "drainage_visible": "yes|no|unknown"
  },
  "soil": {
    "visible_surface_area_percent": 0,
    "surface_condition": "dry|moist|wet|mulched|unknown",
    "estimated_soil_volume_liters": { "min": 0, "max": 0, "confidence": 0 },
    "limitations": ["string"]
  },
  "irrigation": {
    "watering_percent_of_soil_volume": 0,
    "recommended_liters_now": { "min": 0, "max": 0, "best": 0 },
    "recommended_interval_days": { "min": 0, "max": 0 },
    "reason": "string",
    "safety_notes": ["string"]
  },
  "image_quality": {
    "score": 0,
    "limitations": ["string"]
  },
  "overall_confidence": 0,
  "requires_human_review": false
}
`;

function parseJsonResponse(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("AI response was not valid JSON");
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateContentWithRetry(
  modelOrSystemInstruction:
    | string
    | { generateContent: (parts: any[]) => Promise<{ response: { text: () => string } }> },
  parts: unknown[]
) {
  let lastError: unknown;
  const availableKeyAttempts = typeof modelOrSystemInstruction === "string" ? getGeminiApiKeys().length : 1;
  const maxAttempts = Math.max(3, availableKeyAttempts * 2);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const model = typeof modelOrSystemInstruction === "string"
        ? new GoogleGenerativeAI(getGeminiApiKey()).getGenerativeModel({
          model: "gemini-2.5-flash",
          systemInstruction: modelOrSystemInstruction
        })
        : modelOrSystemInstruction;

      return await model.generateContent(parts as any[]);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : "";
      const normalized = message.toLowerCase();
      const retryable = message.includes("503")
        || message.includes("429")
        || normalized.includes("high demand")
        || normalized.includes("api key")
        || normalized.includes("permission")
        || normalized.includes("unauthorized")
        || normalized.includes("forbidden");
      if (!retryable || attempt === maxAttempts - 1) break;
      await wait(900 * (attempt + 1));
    }
  }

  throw lastError;
}

const AGRI_ADVISOR_SYSTEM_PROMPT = `
You are an AI agronomy and project operations advisor for a precision irrigation platform.

Return valid JSON only. No markdown.

Use the provided land, place, weather, and platform state. Give practical, low-cost recommendations
that a farmer and a project manager can act on. Do not invent sensor values or images. If data is
missing, state the missing data and recommend the next measurement.

All user-facing string values must be in Arabic. Keep JSON keys in English exactly as required.

Required JSON:
{
  "executive_summary": "string",
  "field_readiness_score": 0,
  "priority_actions": [
    {
      "title": "string",
      "reason": "string",
      "impact": "water_saving|pest_risk|yield|operations|data_quality",
      "urgency": "low|medium|high"
    }
  ],
  "irrigation_strategy": {
    "recommended_mode": "manual_review|scheduled|automatic",
    "why": "string",
    "rain_adjustment_note": "string"
  },
  "pest_watch": {
    "risk_level": "low|medium|high",
    "what_to_inspect": ["string"],
    "image_capture_guidance": ["string"]
  },
  "project_manager_view": {
    "judge_pitch": "string",
    "value_metrics": ["string"],
    "next_integrations": ["string"]
  },
  "missing_data": ["string"]
}
`;

const ACTION_PLAN_SYSTEM_PROMPT = `
You are an AI operations planner for a precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land operations, weather, and platform data. Do not invent sensor readings.
Create a practical 7-day action plan that a farmer can follow and a project manager can present.

Required JSON:
{
  "plan_title": "string",
  "decision": "irrigate_now|inspect_first|wait|collect_data|connect_iot",
  "decision_reason": "string",
  "expected_impact": {
    "water_saving_liters": 0,
    "risk_reduction": "low|medium|high",
    "manager_value": "string"
  },
  "tasks": [
    {
      "day": 1,
      "title": "string",
      "owner": "farmer|operator|manager",
      "priority": "low|medium|high",
      "evidence": "string",
      "success_metric": "string"
    }
  ],
  "demo_talking_points": ["string"],
  "data_to_collect_next": ["string"]
}
`;

const OPERATOR_CHECKLIST_SYSTEM_PROMPT = `
You are an AI field operations dispatcher for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land, latest unified AI decisions, action plans, weather-risk result,
irrigation recommendations, IoT commands, devices, telemetry, field notes, and analyses.
Do not invent field visits, sensor readings, pests, or device acknowledgements.

Create a concise checklist for the field operator for the next 24 hours. The checklist must be usable
without reading the whole dashboard and must help a project manager prove operational value to judges.

Required JSON:
{
  "title": "string",
  "overall_priority": "low|medium|high",
  "operator_summary": "string",
  "checklist": [
    {
      "step": 1,
      "task": "string",
      "owner": "farmer|operator|manager",
      "priority": "low|medium|high",
      "time_window": "string",
      "evidence": "string",
      "done_when": "string"
    }
  ],
  "do_not_do": ["string"],
  "manager_note": "string",
  "missing_data": ["string"]
}
`;

const JUDGE_REPORT_SYSTEM_PROMPT = `
You are a startup demo strategist and AI agriculture product analyst.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use the provided platform metrics and current capabilities. Do not invent integrations that are not present.
Create a compelling but honest competition judge report that explains why this platform matters.

Required JSON:
{
  "headline": "string",
  "one_minute_pitch": "string",
  "problem": "string",
  "solution": "string",
  "ai_value": ["string"],
  "user_value": ["string"],
  "manager_value": ["string"],
  "demo_flow": [
    {
      "step": "string",
      "what_judges_should_notice": "string"
    }
  ],
  "current_metrics_story": "string",
  "risks_and_mitigations": [
    {
      "risk": "string",
      "mitigation": "string"
    }
  ],
  "next_30_days": ["string"],
  "winning_angle": "string"
}
`;

const FIELD_NOTE_TRIAGE_SYSTEM_PROMPT = `
You are an AI field triage assistant for farmers using a precision irrigation and pest detection platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use the provided farmer note, crop, place, weather, and optional platform context.
Do not claim a final diagnosis. Provide a practical screening result and next checks.

Required JSON:
{
  "triage_summary": "string",
  "likely_causes": [
    {
      "cause": "string",
      "confidence": 0,
      "why": "string"
    }
  ],
  "immediate_actions": [
    {
      "title": "string",
      "priority": "low|medium|high",
      "how_to_do_it": "string"
    }
  ],
  "irrigation_adjustment": {
    "needed": false,
    "recommendation": "string"
  },
  "pest_or_disease_watch": {
    "risk_level": "low|medium|high",
    "what_to_photograph": ["string"]
  },
  "when_to_escalate": "string",
  "missing_data": ["string"]
}
`;

const PEST_RESPONSE_SYSTEM_PROMPT = `
You are an AI pest response planner for a real precision agriculture platform focused on red palm weevil.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land, latest image analyses, imagery metadata, field notes, irrigation recommendations,
and IoT/device context. Do not invent pests, lab tests, field visits, treatments, or official diagnoses.

Create a practical first-response plan for the next 48 hours. This is a screening and operations plan,
not a final diagnosis. If evidence is weak, prioritize better images and human inspection.

Required JSON:
{
  "headline": "string",
  "pest_risk": "none|low|medium|high",
  "red_palm_weevil_watch": {
    "suspected": false,
    "confidence": 0,
    "evidence": ["string"]
  },
  "immediate_actions": [
    {
      "title": "string",
      "priority": "low|medium|high",
      "owner": "farmer|operator|manager",
      "how": "string",
      "done_when": "string"
    }
  ],
  "photo_evidence_needed": ["string"],
  "irrigation_caution": "string",
  "escalation": {
    "needed": false,
    "when": "string",
    "who": "string"
  },
  "manager_value": "string",
  "missing_data": ["string"]
}
`;

const DAILY_BRIEF_SYSTEM_PROMPT = `
You are an AI operations chief for a precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use the provided platform state. Do not invent sensor readings or field visits.
Create a daily operations brief that helps a farmer and project manager decide what to do first today.

Required JSON:
{
  "brief_title": "string",
  "today_summary": "string",
  "top_priorities": [
    {
      "priority": "string",
      "owner": "farmer|operator|manager",
      "urgency": "low|medium|high",
      "why_now": "string"
    }
  ],
  "lands_to_watch": [
    {
      "land_name": "string",
      "reason": "string",
      "recommended_next_step": "string"
    }
  ],
  "manager_notes": ["string"],
  "demo_value": "string",
  "missing_data_to_unlock_more_ai": ["string"]
}
`;

const PORTFOLIO_PRIORITY_SYSTEM_PROMPT = `
You are an AI portfolio operations planner for a precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided lands, analyses, irrigation recommendations, IoT devices, telemetry availability,
field notes, action plans, AI decisions, and platform gaps. Do not invent field visits, sensor readings,
yield, revenue, or pest findings.

Rank the saved lands by operational priority for the next 24 hours. The answer must help a project
manager decide where to send an operator first and must also explain the value clearly for competition
judges. Prefer evidence-based ranking. If the evidence is weak, rank data collection as the priority.

Required JSON:
{
  "headline": "string",
  "portfolio_risk": "low|medium|high",
  "manager_summary": "string",
  "ranked_lands": [
    {
      "rank": 1,
      "land_id": 0,
      "land_name": "string",
      "priority": "low|medium|high",
      "primary_reason": "string",
      "recommended_action": "inspect|irrigate|collect_images|connect_iot|review_data|wait",
      "evidence": ["string"],
      "missing_data": ["string"]
    }
  ],
  "dispatch_plan": [
    {
      "owner": "farmer|operator|manager",
      "task": "string",
      "target_land": "string",
      "time_window": "string",
      "success_metric": "string"
    }
  ],
  "judge_value": "string",
  "system_gaps": ["string"]
}
`;

const ROI_NARRATIVE_SYSTEM_PROMPT = `
You are an AI business value analyst for a precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided calculated metrics and assumptions. Do not invent revenue, yield, or sensor data.
Explain the value for both a farmer and a project manager in a way suitable for competition judges.

Required JSON:
{
  "roi_headline": "string",
  "farmer_value": "string",
  "manager_value": "string",
  "judge_value": "string",
  "metrics_explained": ["string"],
  "assumptions": ["string"],
  "next_data_to_improve_roi": ["string"]
}
`;

const IRRIGATION_COMMAND_SAFETY_SYSTEM_PROMPT = `
You are an AI safety reviewer for a real precision irrigation and IoT control platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Review whether the platform should publish the proposed irrigation command to an ESP32 valve.
Use only the provided land, latest analysis, recommendation, command, and device context.
Do not invent sensor readings. If critical data is missing, prefer a cautious decision.

Approve only when the command duration is reasonable, the recommendation is supported by available
evidence, and there is no clear pest/field risk that requires inspection before watering.

Required JSON:
{
  "decision": "approve|hold",
  "risk_level": "low|medium|high",
  "reason": "string",
  "operator_message": "string",
  "checks": [
    {
      "name": "string",
      "status": "pass|warning|fail",
      "details": "string"
    }
  ],
  "required_before_retry": ["string"]
}
`;

const SENSOR_INSIGHT_SYSTEM_PROMPT = `
You are an AI sensor operations analyst for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land, recent ESP32 telemetry, recommendations, AI image analyses, and weather.
Do not invent sensor readings. If telemetry is missing or too sparse, explain exactly what data is needed.
Translate raw sensor readings into decisions a farmer and project manager can act on.

Required JSON:
{
  "headline": "string",
  "sensor_confidence": 0,
  "irrigation_decision": "irrigate_now|wait|inspect_sensor|collect_more_data",
  "decision_reason": "string",
  "anomaly_watch": [
    {
      "signal": "string",
      "risk": "low|medium|high",
      "evidence": "string",
      "next_check": "string"
    }
  ],
  "farmer_actions": [
    {
      "title": "string",
      "priority": "low|medium|high",
      "how": "string"
    }
  ],
  "manager_value": "string",
  "missing_data": ["string"]
}
`;

const HARDWARE_READINESS_SYSTEM_PROMPT = `
You are an AI hardware commissioning auditor for a real precision irrigation platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land, ESP32 device records, MQTT configuration flags, recent commands,
ACK payloads, and telemetry. Do not invent hardware, acknowledgements, or sensor readings.
Your job is to tell the operator and project manager whether the physical irrigation hardware is
ready for a live demo and real operation.

Required JSON:
{
  "headline": "string",
  "readiness": "ready|partial|not_ready",
  "score": 0,
  "operator_summary": "string",
  "checks": [
    {
      "name": "string",
      "status": "pass|warning|fail",
      "evidence": "string",
      "fix": "string"
    }
  ],
  "safe_demo_action": {
    "allowed": false,
    "action": "string",
    "reason": "string"
  },
  "next_steps": ["string"],
  "manager_value": "string",
  "missing_data": ["string"]
}
`;

const WEATHER_IRRIGATION_SYSTEM_PROMPT = `
You are an AI weather and irrigation risk advisor for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land, OpenWeather forecast, recent irrigation recommendations, image analyses,
and telemetry. Do not invent rain, temperature, humidity, wind, soil moisture, or device readings.

Your job is to tell the farmer whether today's irrigation should continue, be reduced, be delayed,
or require inspection because of weather and field evidence. Explain the project-manager value for judges.

Required JSON:
{
  "headline": "string",
  "weather_risk": "low|medium|high",
  "irrigation_adjustment": "increase|normal|reduce|delay|inspect_first",
  "confidence": 0,
  "why": "string",
  "rain_effect": {
    "forecast_rain_mm": 0,
    "recommendation": "string"
  },
  "heat_or_humidity_watch": [
    {
      "signal": "string",
      "risk": "low|medium|high",
      "action": "string"
    }
  ],
  "farmer_actions": [
    {
      "title": "string",
      "priority": "low|medium|high",
      "time_window": "string"
    }
  ],
  "manager_value": "string",
  "missing_data": ["string"]
}
`;

const IRRIGATION_SCHEDULE_SYSTEM_PROMPT = `
You are an AI irrigation scheduler for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land record, OpenWeather forecast, recent irrigation recommendations,
image analyses, IoT devices, telemetry, and AI decisions. Do not invent sensors or hardware.
Your job is to turn the latest evidence into a practical irrigation schedule for the next 24 hours.
If evidence is weak, schedule inspection or manual approval instead of automatic watering.
Do not assume every crop needs daily irrigation. If the latest recommendation includes
irrigation_interval_days, liters_per_irrigation, or daily_average_liters, honor those fields:
daily_average_liters is only an accounting average, not an instruction to run the valve every day.
If irrigation_interval_days is greater than 1 and there is no last irrigation timestamp or soil
moisture telemetry proving the field is due today, do not create an automatic daily watering slot.
Use manual_approval or collect_data and ask the operator to confirm the last watering date.
Treat tank water as finite. If water_budget or projectContext includes tank_available_liters,
usable_tank_liters, tank_reserve_liters, or tank_shortage_liters, never schedule more water than
usable_tank_liters. If tank_shortage_liters is greater than 0, hold MQTT and ask for refill or
explicit partial-irrigation approval.

Required JSON:
{
  "title": "string",
  "mode": "auto_ready|manual_approval|wait|collect_data",
  "confidence": 0,
  "summary": "string",
  "water_budget": {
    "liters_next_24h": 0,
    "daily_average_liters": 0,
    "liters_per_irrigation": 0,
    "executable_liters": 0,
    "tank_available_liters": 0,
    "tank_reserve_liters": 0,
    "usable_tank_liters": 0,
    "tank_shortage_liters": 0,
    "can_complete_irrigation": false,
    "irrigation_interval_days": 1,
    "rain_deduction_liters": 0,
    "source_recommendation_id": 0
  },
  "slots": [
    {
      "slot": 1,
      "start_after_minutes": 0,
      "duration_seconds": 0,
      "valve_status": "ON|OFF|INSPECT",
      "reason": "string",
      "send_mqtt": false,
      "requires_operator_approval": true
    }
  ],
  "safety_checks": ["string"],
  "operator_message": "string",
  "manager_value": "string",
  "missing_data": ["string"]
}
`;

const LAND_EVIDENCE_REPORT_SYSTEM_PROMPT = `
You are an AI evidence auditor for a precision agriculture competition MVP.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land record, imagery, analyses, irrigation recommendations, IoT commands,
telemetry, field notes, action plans, and weather. Do not invent measurements, device responses, or
photos. Separate proven evidence from missing evidence. The report should help a project manager
explain the real value to judges without exaggeration.

Required JSON:
{
  "title": "string",
  "executive_summary": "string",
  "evidence_score": 0,
  "proof_points": [
    {
      "claim": "string",
      "evidence": "string",
      "strength": "weak|medium|strong"
    }
  ],
  "timeline": [
    {
      "event": "string",
      "source": "map|image_ai|weather|iot|sensor|field_note|action_plan",
      "timestamp": "string",
      "why_it_matters": "string"
    }
  ],
  "current_decision": {
    "decision": "irrigate|wait|inspect|collect_data|connect_device",
    "reason": "string"
  },
  "judge_demo_script": ["string"],
  "missing_evidence": ["string"],
  "next_best_step": "string"
}
`;

const LAND_QA_SYSTEM_PROMPT = `
You are an AI field copilot for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Answer the user's question using only the provided land operations data: land record, imagery,
AI analyses, pest summaries, irrigation recommendations, IoT commands, devices, telemetry,
field notes, action plans, AI decisions, and weather if available.

If landOps.land_memory is provided, treat it as the authoritative de-duplicated memory for plant
counts and image evidence. Raw AI analyses are historical evidence only and must not override
land_memory when counts conflict.

Do not invent sensor readings, images, field visits, device acknowledgements, or diagnoses.
If the data is insufficient, say what is missing and what the user should collect next.

Required JSON:
{
  "answer": "string",
  "confidence": 0,
  "evidence_used": [
    {
      "source": "land|image_ai|weather|recommendation|iot|sensor|field_note|action_plan|decision",
      "detail": "string"
    }
  ],
  "recommended_next_step": "string",
  "missing_data": ["string"]
}
`;

const LAND_AGENT_SYSTEM_PROMPT = `
You are a tool-using operations agent for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
You do not directly publish MQTT. You prepare an auditable action for Admin approval.

Use only the provided tool_results and context. Do not invent sensor readings, field visits,
image analyses, device acknowledgements, water tank values, or pest findings.

Critical policy:
- The water source is a finite tank, not running water.
- If context.targetType is "potted_container", use the potted/container irrigation preview as the irrigation source.
  Do not use field crop catalog values, land area, Open-Meteo soil moisture, or SoilGrids moisture to size water for the pot.
  ESP32 soil_moisture_percent is authoritative for current watering safety and must not be described as conflicting with
  weather/Open-Meteo moisture. If ESP32 moisture is high, the correct decision is wait/near-zero irrigation.
- For potted/container plants, never suggest a water amount larger than the safe container/soil cap included in calculate_irrigation.
- Never recommend automatic irrigation if tank_shortage_liters > 0.
- Never recommend automatic irrigation if pest risk is high.
- Never recommend automatic irrigation if no active ESP32 device is available.
- If irrigation_interval_days > 1 and there is no soil moisture or last irrigation evidence,
  require Admin/operator approval instead of automatic execution.
- If the user asks to execute, prepare the command but set requires_admin_approval true unless every safety check passes.
- MQTT irrigation command duration must be within 1..1800 seconds. If the full irrigation would exceed
  this, prepare only the first safe batch and add a next action to split the irrigation into batches.

Required JSON:
{
  "agent_name": "AgriAI Operations Agent",
  "intent": "string",
  "decision": "irrigate_now|prepare_irrigation|wait|inspect|collect_data|refill_tank|connect_device|manual_review",
  "confidence": 0,
  "summary": "string",
  "tool_trace": [
    {
      "tool": "get_land_state|read_weather|read_plant_inventory|calculate_irrigation|check_tank|check_iot|check_pests|prepare_mqtt_command",
      "status": "pass|warning|fail",
      "result": "string"
    }
  ],
  "proposed_command": {
    "allowed_to_prepare": false,
    "requires_admin_approval": true,
    "mqtt_topic": "string",
    "payload": {
      "land_id": 0,
      "device_uid": "string",
      "status": "ON|OFF",
      "duration_seconds": 0,
      "liters_target": 0,
      "reason": "string"
    }
  },
  "safety_checks": [
    {
      "name": "string",
      "status": "pass|warning|fail",
      "details": "string"
    }
  ],
  "next_actions": [
    {
      "owner": "admin|operator|farmer|hardware",
      "action": "string",
      "priority": "low|medium|high"
    }
  ],
  "missing_data": ["string"]
}
`;

const FIELD_WORK_ORDERS_SYSTEM_PROMPT = `
You are an AI field operations planner for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land operations evidence: land, imagery, AI analyses, pest summaries,
irrigation recommendations, irrigation schedules, hardware readiness, IoT devices, telemetry,
field notes, AI decisions, and action plans. Do not invent completed work, sensors, images, or ACKs.

Your job is to convert evidence into concrete work orders for the next 48 hours. Tasks must be
actionable by a farmer, operator, hardware person, or manager, and each task needs a success check.

Required JSON:
{
  "headline": "string",
  "summary": "string",
  "work_orders": [
    {
      "title": "string",
      "owner_role": "farmer|operator|manager|hardware",
      "priority": "low|medium|high",
      "due_in_hours": 0,
      "why": "string",
      "how": "string",
      "success_check": "string",
      "evidence": ["string"]
    }
  ],
  "manager_value": "string",
  "missing_data": ["string"]
}
`;

const UNIFIED_DECISION_SYSTEM_PROMPT = `
You are the AI decision controller for a real precision agriculture platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided land, recent imagery, AI image analyses, irrigation recommendations, IoT commands,
ESP32 telemetry, field notes, action plans, weather, and project context. Do not invent measurements,
device acknowledgements, images, pest findings, or sensor values.

Your job is to merge all available signals into one operational decision that a farmer can execute now
and a project manager can defend in front of competition judges. Prefer practical next steps over generic
advice. If automatic irrigation is risky because evidence is weak, say so clearly.

Required JSON:
{
  "headline": "string",
  "decision": "irrigate_now|wait|inspect_pest|collect_images|connect_iot|manual_review",
  "confidence": 0,
  "risk_level": "low|medium|high",
  "why": "string",
  "evidence_used": [
    {
      "source": "map|weather|image_ai|imagery|iot_command|sensor|field_note|action_plan|recommendation",
      "finding": "string",
      "strength": "weak|medium|strong"
    }
  ],
  "farmer_next_actions": [
    {
      "title": "string",
      "priority": "low|medium|high",
      "time_window": "string",
      "success_check": "string"
    }
  ],
  "automation": {
    "allowed": false,
    "reason": "string",
    "suggested_duration_seconds": 0,
    "requires_human_approval": true
  },
  "manager_view": {
    "judge_story": "string",
    "business_value": "string",
    "weakest_link": "string"
  },
  "missing_data": ["string"]
}
`;

const DEMO_READINESS_SYSTEM_PROMPT = `
You are an AI competition readiness advisor for a real precision agriculture MVP.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided configuration flags, database metrics, evidence counts, and missing integrations.
Do not pretend missing MQTT, sensors, images, or devices are ready. Turn gaps into a practical pre-demo plan.

Required JSON:
{
  "readiness_score": 0,
  "readiness_label": "not_ready|partial|demo_ready|strong",
  "headline": "string",
  "judge_story": "string",
  "ready_capabilities": ["string"],
  "critical_gaps": [
    {
      "gap": "string",
      "why_it_matters": "string",
      "fix": "string",
      "priority": "high|medium|low"
    }
  ],
  "next_72_hours": [
    {
      "task": "string",
      "owner": "developer|hardware|presenter|farmer",
      "success_evidence": "string"
    }
  ],
  "demo_flow": ["string"]
}
`;

const PHOTO_MISSION_SYSTEM_PROMPT = `
You are an AI field image capture planner for a precision agriculture and pest detection platform.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Create a practical photo mission for a farmer, phone operator, or drone operator before image analysis.
Use only the provided land, crop, place, weather, and platform context. Do not claim that images exist.
Prioritize shots that improve plant counting, irrigation assessment, and red palm weevil screening.

Required JSON:
{
  "mission_title": "string",
  "capture_priority": "low|medium|high",
  "why_now": "string",
  "shots": [
    {
      "title": "string",
      "device": "phone|drone|either",
      "distance": "string",
      "angle": "string",
      "target": "string",
      "success_criteria": "string"
    }
  ],
  "red_palm_weevil_focus": ["string"],
  "avoid": ["string"],
  "minimum_set_for_demo": ["string"],
  "after_capture_next_step": "string"
}
`;

const DEMO_RUNBOOK_SYSTEM_PROMPT = `
You are an AI demo director for a real precision agriculture MVP shown to technical judges.

Return valid JSON only. No markdown. All user-facing string values must be in Arabic.
Use only the provided platform state and evidence counts. Do not invent completed hardware, sensors, images,
or MQTT connectivity that are not present in the state. The output must help a presenter show the platform
step by step as a real operational system: map, saved land, AI analysis, weather, irrigation decision,
IoT automation readiness, and project manager value.

Required JSON:
{
  "title": "string",
  "opening_line": "string",
  "demo_steps": [
    {
      "step": 1,
      "screen": "map|manager_board|land_ops|image_analysis|iot|report",
      "action": "string",
      "talk_track": "string",
      "evidence_to_show": "string",
      "judge_should_notice": "string"
    }
  ],
  "fallback_if_live_ai_quota_fails": ["string"],
  "honest_gaps": ["string"],
  "closing_line": "string"
}
`;

export async function analyzeAgricultureImage(input: {
  imageBase64: string;
  mimeType: string;
  land: {
    id?: number;
    name?: string;
    cropHint?: string;
    areaM2?: number;
  };
  weather: unknown;
  sensorContext?: unknown;
}) {
  const result = await generateContentWithRetry(AGRI_ANALYSIS_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        land: input.land,
        weather: input.weather,
        sensorContext: input.sensorContext,
        instruction: "Analyze the attached image and return the required JSON only."
      })
    },
    {
      inlineData: {
        data: input.imageBase64,
        mimeType: input.mimeType
      }
    }
  ]);

  const text = result.response.text();
  return parseJsonResponse(text);
}

export async function analyzePottedPlantImage(input: {
  imageBase64: string;
  mimeType: string;
  context: {
    flowRateLitersPerMinute?: number;
    notes?: string;
    sensorContext?: unknown;
    moisturePolicy?: string;
  };
}) {
  const result = await generateContentWithRetry(POTTED_PLANT_ANALYSIS_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        context: input.context,
        instruction: "Analyze the attached potted/container plant image and return the required JSON only."
      })
    },
    {
      inlineData: {
        data: input.imageBase64,
        mimeType: input.mimeType
      }
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateLandAdvisory(input: {
  land: {
    id?: number;
    name?: string;
    cropHint?: string;
    areaM2?: number;
    autoIrrigationEnabled?: boolean;
  };
  place: unknown;
  weather: unknown;
  platform: {
    hasImageAnalysis: boolean;
    hasIotDevice: boolean;
    savedLandsCount: number;
  };
}) {
  const result = await generateContentWithRetry(AGRI_ADVISOR_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateActionPlan(input: {
  landOps: unknown;
  weather: unknown;
  place: unknown;
}) {
  const result = await generateContentWithRetry(ACTION_PLAN_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateOperatorChecklist(input: {
  landOps: unknown;
  weatherRisk: unknown;
  place: unknown;
}) {
  const result = await generateContentWithRetry(OPERATOR_CHECKLIST_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateJudgeReport(input: {
  dashboard: unknown;
  capabilities: string[];
  missingIntegrations: string[];
}) {
  const result = await generateContentWithRetry(JUDGE_REPORT_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function triageFieldNote(input: {
  note: string;
  land: {
    name?: string;
    cropHint?: string;
    areaM2?: number;
  };
  place: unknown;
  weather: unknown;
  platformContext: unknown;
}) {
  const result = await generateContentWithRetry(FIELD_NOTE_TRIAGE_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generatePestResponsePlan(input: {
  landOps: unknown;
}) {
  const result = await generateContentWithRetry(PEST_RESPONSE_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateDailyBrief(input: {
  platformState: unknown;
}) {
  const result = await generateContentWithRetry(DAILY_BRIEF_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generatePortfolioPriority(input: {
  portfolioState: unknown;
}) {
  const result = await generateContentWithRetry(PORTFOLIO_PRIORITY_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateRoiNarrative(input: {
  metrics: unknown;
  assumptions: unknown;
}) {
  const result = await generateContentWithRetry(ROI_NARRATIVE_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function reviewIrrigationCommandSafety(input: {
  land: unknown;
  latestAnalysis: unknown;
  recommendation: unknown;
  command: unknown;
  device: unknown;
}) {
  const result = await generateContentWithRetry(IRRIGATION_COMMAND_SAFETY_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateSensorInsight(input: {
  land: unknown;
  telemetry: unknown;
  recommendations: unknown;
  analyses: unknown;
  weather: unknown;
}) {
  const result = await generateContentWithRetry(SENSOR_INSIGHT_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateHardwareReadiness(input: {
  hardwareState: unknown;
}) {
  const result = await generateContentWithRetry(HARDWARE_READINESS_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateWeatherIrrigationRisk(input: {
  land: unknown;
  weather: unknown;
  recommendations: unknown;
  analyses: unknown;
  telemetry: unknown;
}) {
  const result = await generateContentWithRetry(WEATHER_IRRIGATION_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateIrrigationSchedule(input: {
  landOps: unknown;
  weather: unknown;
  projectContext: unknown;
}) {
  const result = await generateContentWithRetry(IRRIGATION_SCHEDULE_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateLandEvidenceReport(input: {
  landOps: unknown;
  weather: unknown;
}) {
  const result = await generateContentWithRetry(LAND_EVIDENCE_REPORT_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function answerLandQuestion(input: {
  question: string;
  landOps: unknown;
  weather: unknown;
}) {
  const result = await generateContentWithRetry(LAND_QA_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function runLandOperationsAgent(input: {
  message: string;
  context: unknown;
  toolResults: unknown;
}) {
  const result = await generateContentWithRetry(LAND_AGENT_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateFieldWorkOrders(input: {
  operationsState: unknown;
}) {
  const result = await generateContentWithRetry(FIELD_WORK_ORDERS_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateUnifiedDecision(input: {
  landOps: unknown;
  weather: unknown;
  place: unknown;
  projectContext: unknown;
}) {
  const result = await generateContentWithRetry(UNIFIED_DECISION_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateDemoReadinessReport(input: {
  configuration: unknown;
  metrics: unknown;
  evidence: unknown;
  missingIntegrations: string[];
}) {
  const result = await generateContentWithRetry(DEMO_READINESS_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generatePhotoMission(input: {
  land: unknown;
  place: unknown;
  weather: unknown;
  platformContext: unknown;
}) {
  const result = await generateContentWithRetry(PHOTO_MISSION_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

export async function generateDemoRunbook(input: {
  platformState: unknown;
}) {
  const result = await generateContentWithRetry(DEMO_RUNBOOK_SYSTEM_PROMPT, [
    {
      text: JSON.stringify({
        ...input,
        instruction: "Return the required JSON only."
      })
    }
  ]);

  return parseJsonResponse(result.response.text());
}

