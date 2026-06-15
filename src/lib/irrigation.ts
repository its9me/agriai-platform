import type { AgronomicContext } from "./agro-data";
import { soilMoistureIrrigationFactor } from "./sensor-context";

export type PlantFinding = {
  name: string;
  count: number;
};

export type IrrigationMode = "survival" | "medium_productivity" | "full_irrigation";

export type CropIrrigationProfile = {
  id: string;
  nameEn: string;
  nameAr: string;
  aliases: string[];
  unit: "plant" | "tree" | "m2";
  litersPerUnitPerIrrigation: number;
  intervalDays: number;
  wateringPercent: number;
  season: string;
  method: string;
  source: string;
  seasonalWaterMmMin?: number;
  seasonalWaterMmMax?: number;
  seasonalWaterMmDefault?: number;
  seasonLengthDays?: number;
  monthlyDailyLiters?: number[];
  useLandAreaByDefault?: boolean;
  modeFactors?: Partial<Record<IrrigationMode, number>>;
};

const FAO_METHOD = "FAO water balance: ICU = ETc - effective rain - soil moisture change; ETc = Kc x ETo; 1 mm = 1 L/m2.";
const IRAQ_WATER_POLICY = "Iraq context: agriculture is the dominant water user; use precision irrigation and tank limits to reduce waste.";
const IRRIGATION_MODE_SOURCE = "Mode policy combines FAO ETc/Kc crop-water requirement, regulated deficit-irrigation ranges, Iraq wheat/rice seasonal water-consumption research, and ICBA date-palm guidance. The modes describe how much water to apply toward the target state, not how much water the plant actually absorbed.";
const IRRIGATION_MODE_GUIDE: Record<IrrigationMode, { label: string; factor: number; reason: string }> = {
  survival: {
    label: "Survival / minimum irrigation",
    factor: 0.35,
    reason: "Minimum deficit irrigation to reduce severe stress and keep permanent crops alive; not a yield target."
  },
  medium_productivity: {
    label: "Medium productivity",
    factor: 0.70,
    reason: "Regulated deficit irrigation target near 50-70% of ETc to save water while preserving useful production."
  },
  full_irrigation: {
    label: "Full irrigation",
    factor: 1,
    reason: "Full crop-water requirement target based on ETc after effective rain deduction."
  }
};

export function normalizeIrrigationMode(value: unknown): IrrigationMode | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "survival" || normalized === "minimum" || normalized === "survive") return "survival";
  if (normalized === "medium_productivity" || normalized === "medium" || normalized === "production") return "medium_productivity";
  if (normalized === "full_irrigation" || normalized === "full" || normalized === "complete") return "full_irrigation";
  return null;
}

function fieldCrop(
  input: Omit<CropIrrigationProfile, "unit" | "litersPerUnitPerIrrigation" | "method" | "source"> & {
    seasonalWaterMmMin: number;
    seasonalWaterMmMax: number;
    seasonalWaterMmDefault: number;
    seasonLengthDays: number;
    source: string;
    useLandAreaByDefault?: boolean;
  }
): CropIrrigationProfile {
  const dailyMm = input.seasonalWaterMmDefault / Math.max(1, input.seasonLengthDays);
  return {
    ...input,
    unit: "m2",
    litersPerUnitPerIrrigation: Number((dailyMm * input.intervalDays).toFixed(2)),
    method: FAO_METHOD,
    source: input.source,
    useLandAreaByDefault: input.useLandAreaByDefault
  };
}

export const IRAQ_CROP_IRRIGATION_CATALOG: CropIrrigationProfile[] = [
  {
    id: "date_palm",
    nameEn: "Date Palm",
    nameAr: "نخيل تمر",
    aliases: ["date palm", "palm", "نخلة", "نخيل", "تمر", "date"],
    unit: "tree",
    litersPerUnitPerIrrigation: 180,
    intervalDays: 1,
    wateringPercent: 100,
    season: "نخلة منتجة: شتاء 80-110 L/day، موسم نمو/إثمار 140-180 L/day. القيم تتغير حسب العمر والملوحة والتربة.",
    method: "Tree-based seasonal date palm schedule from ICBA; dashboard picks the current month automatically.",
    source: "ICBA date palm guideline 2023; user-provided local rule: vegetative 50-75 L/day, fruiting/production 100-200 L/day.",
    monthlyDailyLiters: [110, 110, 140, 160, 180, 180, 180, 140, 130, 100, 80, 80],
    modeFactors: { survival: 0.3, medium_productivity: 0.65, full_irrigation: 1 }
  },
  {
    id: "citrus",
    nameEn: "Citrus",
    nameAr: "حمضيات",
    aliases: ["citrus", "orange", "lemon", "برتقال", "ليمون", "حمضيات", "نارنج"],
    unit: "tree",
    litersPerUnitPerIrrigation: 130,
    intervalDays: 3,
    wateringPercent: 85,
    season: "أشجار مثمرة بالعراق: كل 3-5 أيام بالصيف، أقل بالشتاء.",
    method: "Tree schedule calibrated to hot arid Iraq conditions; FAO climate/rain deduction is applied after crop demand.",
    source: IRAQ_WATER_POLICY
  },
  {
    id: "pomegranate",
    nameEn: "Pomegranate",
    nameAr: "رمان",
    aliases: ["pomegranate", "رمان"],
    unit: "tree",
    litersPerUnitPerIrrigation: 95,
    intervalDays: 4,
    wateringPercent: 75,
    season: "كل 4-7 أيام، تزيد في الحر وتقل بعد الحصاد.",
    method: "Tree schedule with water-saving factor and rain deduction.",
    source: IRAQ_WATER_POLICY
  },
  {
    id: "fig",
    nameEn: "Fig",
    nameAr: "تين",
    aliases: ["fig", "تين"],
    unit: "tree",
    litersPerUnitPerIrrigation: 85,
    intervalDays: 5,
    wateringPercent: 65,
    season: "كل 5-8 أيام؛ يتحمل الجفاف أكثر من الحمضيات.",
    method: "Tree schedule with water-saving factor and rain deduction.",
    source: IRAQ_WATER_POLICY
  },
  {
    id: "grape",
    nameEn: "Grape",
    nameAr: "عنب",
    aliases: ["grape", "grapes", "vine", "عنب", "كرمة"],
    unit: "tree",
    litersPerUnitPerIrrigation: 60,
    intervalDays: 3,
    wateringPercent: 75,
    season: "كل 3-5 أيام في الصيف؛ تخفيف الري قرب النضج حسب الإدارة.",
    method: "Vine/tree schedule with water-saving factor and rain deduction.",
    source: IRAQ_WATER_POLICY
  },
  {
    id: "olive",
    nameEn: "Olive",
    nameAr: "زيتون",
    aliases: ["olive", "زيتون"],
    unit: "tree",
    litersPerUnitPerIrrigation: 60,
    intervalDays: 7,
    wateringPercent: 50,
    season: "كل 7-14 يوم؛ محصول متحمل نسبياً للجفاف.",
    method: "Tree schedule with deficit-irrigation style water-saving factor.",
    source: IRAQ_WATER_POLICY
  },
  fieldCrop({
    id: "wheat",
    nameEn: "Wheat",
    nameAr: "حنطة/قمح",
    aliases: ["wheat", "قمح", "حنطة"],
    intervalDays: 7,
    wateringPercent: 100,
    season: "موسم نمو تقريبي 150 يوم؛ البحث العراقي يضع الاستهلاك بين 203.9 و534.5 mm حسب المنطقة.",
    seasonalWaterMmMin: 203.9,
    seasonalWaterMmMax: 534.5,
    seasonalWaterMmDefault: 420,
    seasonLengthDays: 150,
    source: "ResearchGate paper: Water consumption of wheat and rice crops in Iraq, 2020.",
    useLandAreaByDefault: true
  }),
  fieldCrop({
    id: "barley",
    nameEn: "Barley",
    nameAr: "شعير",
    aliases: ["barley", "شعير"],
    intervalDays: 8,
    wateringPercent: 85,
    season: "محصول حبوب شتوي أقل طلباً من القمح؛ محسوب بمنهج FAO mm/m2 مع تقليل محافظ.",
    seasonalWaterMmMin: 180,
    seasonalWaterMmMax: 420,
    seasonalWaterMmDefault: 340,
    seasonLengthDays: 140,
    source: "FAO AQUASTAT method adapted for Iraq water-scarcity context.",
    useLandAreaByDefault: true
  }),
  fieldCrop({
    id: "rice",
    nameEn: "Rice",
    nameAr: "رز/شلب",
    aliases: ["rice", "رز", "شلب", "شلبه"],
    intervalDays: 3,
    wateringPercent: 100,
    season: "احتياج عال جداً؛ البحث العراقي يضع الرز بين 1387.1 و1980.7 mm خلال الموسم، وFAO يضيف طبقة غمر 20 cm للرز المغمور.",
    seasonalWaterMmMin: 1387.1,
    seasonalWaterMmMax: 1980.7,
    seasonalWaterMmDefault: 1700,
    seasonLengthDays: 150,
    source: "ResearchGate Iraq wheat/rice paper 2020 + FAO paddy-rice flooding note.",
    useLandAreaByDefault: true
  }),
  fieldCrop({
    id: "alfalfa",
    nameEn: "Alfalfa",
    nameAr: "جت/برسيم",
    aliases: ["alfalfa", "clover", "جت", "برسيم"],
    intervalDays: 5,
    wateringPercent: 90,
    season: "محصول علفي عالي الطلب؛ كل 5-7 أيام حسب الحشة والحرارة.",
    seasonalWaterMmMin: 700,
    seasonalWaterMmMax: 1200,
    seasonalWaterMmDefault: 950,
    seasonLengthDays: 210,
    source: "FAO AQUASTAT method adapted to irrigated forage in arid Iraq.",
    useLandAreaByDefault: true
  }),
  fieldCrop({
    id: "maize",
    nameEn: "Maize",
    nameAr: "ذرة صفراء",
    aliases: ["maize", "corn", "ذرة", "ذرة صفراء"],
    intervalDays: 5,
    wateringPercent: 90,
    season: "كل 5-7 أيام؛ أعلى حاجة عند التزهير وامتلاء الحبوب.",
    seasonalWaterMmMin: 500,
    seasonalWaterMmMax: 800,
    seasonalWaterMmDefault: 650,
    seasonLengthDays: 120,
    source: "FAO AQUASTAT method adapted to summer field crops in Iraq.",
    useLandAreaByDefault: true
  }),
  fieldCrop({
    id: "tomato",
    nameEn: "Tomato",
    nameAr: "طماطم",
    aliases: ["tomato", "طماطم", "بندورة"],
    intervalDays: 2,
    wateringPercent: 90,
    season: "خضار صيفية: رية خفيفة كل 1-2 يوم حسب التربة والحر.",
    seasonalWaterMmMin: 450,
    seasonalWaterMmMax: 700,
    seasonalWaterMmDefault: 580,
    seasonLengthDays: 110,
    source: "FAO ETc/Kc method adapted to vegetable beds; counted plants are treated as occupied m2 when no spacing exists."
  }),
  fieldCrop({
    id: "cucumber",
    nameEn: "Cucumber",
    nameAr: "خيار",
    aliases: ["cucumber", "خيار"],
    intervalDays: 1,
    wateringPercent: 90,
    season: "حساس للعطش؛ غالباً يومي بالصيف.",
    seasonalWaterMmMin: 350,
    seasonalWaterMmMax: 550,
    seasonalWaterMmDefault: 450,
    seasonLengthDays: 80,
    source: "FAO ETc/Kc method adapted to vegetable beds."
  }),
  fieldCrop({
    id: "eggplant",
    nameEn: "Eggplant",
    nameAr: "باذنجان",
    aliases: ["eggplant", "aubergine", "باذنجان"],
    intervalDays: 2,
    wateringPercent: 85,
    season: "كل يومين تقريباً بالصيف؛ يزيد عند الإثمار.",
    seasonalWaterMmMin: 450,
    seasonalWaterMmMax: 700,
    seasonalWaterMmDefault: 560,
    seasonLengthDays: 120,
    source: "FAO ETc/Kc method adapted to vegetable beds."
  }),
  fieldCrop({
    id: "pepper",
    nameEn: "Pepper",
    nameAr: "فلفل",
    aliases: ["pepper", "فلفل"],
    intervalDays: 2,
    wateringPercent: 80,
    season: "كل 1-2 يوم حسب الحر ومرحلة الإثمار.",
    seasonalWaterMmMin: 400,
    seasonalWaterMmMax: 650,
    seasonalWaterMmDefault: 520,
    seasonLengthDays: 120,
    source: "FAO ETc/Kc method adapted to vegetable beds."
  }),
  fieldCrop({
    id: "okra",
    nameEn: "Okra",
    nameAr: "بامية",
    aliases: ["okra", "بامية"],
    intervalDays: 2,
    wateringPercent: 75,
    season: "كل 2-3 أيام؛ تتحمل نسبياً أكثر من الخيار.",
    seasonalWaterMmMin: 350,
    seasonalWaterMmMax: 550,
    seasonalWaterMmDefault: 450,
    seasonLengthDays: 100,
    source: "FAO ETc/Kc method adapted to vegetable beds."
  }),
  fieldCrop({
    id: "potato",
    nameEn: "Potato",
    nameAr: "بطاطا",
    aliases: ["potato", "بطاطا", "بطاطس"],
    intervalDays: 3,
    wateringPercent: 85,
    season: "كل 2-4 أيام؛ تجنب جفاف التربة عند تكوين الدرنات.",
    seasonalWaterMmMin: 400,
    seasonalWaterMmMax: 650,
    seasonalWaterMmDefault: 520,
    seasonLengthDays: 110,
    source: "FAO ETc/Kc method adapted to vegetable beds."
  }),
  fieldCrop({
    id: "onion",
    nameEn: "Onion",
    nameAr: "بصل",
    aliases: ["onion", "بصل"],
    intervalDays: 3,
    wateringPercent: 70,
    season: "كل 2-4 أيام؛ يقل الري قبل القلع.",
    seasonalWaterMmMin: 350,
    seasonalWaterMmMax: 550,
    seasonalWaterMmDefault: 430,
    seasonLengthDays: 120,
    source: "FAO ETc/Kc method adapted to vegetable beds."
  }),
  fieldCrop({
    id: "watermelon",
    nameEn: "Watermelon",
    nameAr: "رقي/بطيخ",
    aliases: ["watermelon", "بطيخ", "رقي"],
    intervalDays: 3,
    wateringPercent: 85,
    season: "كل 2-3 أيام؛ أعلى حاجة أثناء نمو الثمار.",
    seasonalWaterMmMin: 400,
    seasonalWaterMmMax: 650,
    seasonalWaterMmDefault: 520,
    seasonLengthDays: 100,
    source: "FAO ETc/Kc method adapted to cucurbits in Iraq."
  }),
  fieldCrop({
    id: "melon",
    nameEn: "Melon",
    nameAr: "شمام",
    aliases: ["melon", "شمام"],
    intervalDays: 3,
    wateringPercent: 80,
    season: "كل 2-3 أيام؛ يقل قرب النضج حسب الجودة المطلوبة.",
    seasonalWaterMmMin: 350,
    seasonalWaterMmMax: 600,
    seasonalWaterMmDefault: 480,
    seasonLengthDays: 95,
    source: "FAO ETc/Kc method adapted to cucurbits in Iraq."
  })
];

export function findCropIrrigationProfile(name: string) {
  const normalized = name.trim().toLowerCase();
  return IRAQ_CROP_IRRIGATION_CATALOG.find((crop) => {
    return crop.id === normalized
      || crop.nameEn.toLowerCase() === normalized
      || crop.nameAr.toLowerCase() === normalized
      || crop.aliases.some((alias) => alias.toLowerCase() === normalized || normalized.includes(alias.toLowerCase()));
  }) ?? null;
}

function currentMonthIndex() {
  return new Date().getMonth();
}

function profileRawLitersPerIrrigation(profile: CropIrrigationProfile) {
  const monthlyDaily = profile.monthlyDailyLiters?.[currentMonthIndex()];
  if (Number.isFinite(Number(monthlyDaily))) {
    return Number(monthlyDaily) * Math.max(1, profile.intervalDays);
  }
  return profile.litersPerUnitPerIrrigation;
}

export function cropDailyLiters(profile: CropIrrigationProfile) {
  return (profileRawLitersPerIrrigation(profile) / Math.max(1, profile.intervalDays)) * (profile.wateringPercent / 100);
}

export function cropIrrigationLiters(profile: CropIrrigationProfile) {
  return profileRawLitersPerIrrigation(profile) * (profile.wateringPercent / 100);
}

function modeFactor(profile: CropIrrigationProfile | null, mode: IrrigationMode | null, fallbackWaterSavingPercent: number) {
  if (!mode) return fallbackWaterSavingPercent / 100;
  const base = profile?.modeFactors?.[mode] ?? IRRIGATION_MODE_GUIDE[mode].factor;
  if (profile?.unit === "m2" && mode === "survival") return Math.max(base, 0.4);
  if (profile?.unit === "m2" && mode === "medium_productivity") return Math.max(base, 0.7);
  return Math.max(0.2, Math.min(1, base));
}

export function calculateIrrigation(input: {
  plants: PlantFinding[];
  areaM2: number;
  forecastRainMm: number;
  flowRateLitersPerMinute: number;
  tankAvailableLiters?: number;
  tankReserveLiters?: number;
  waterSavingPercent?: number;
  irrigationMode?: IrrigationMode | string | null;
  agronomicContext?: AgronomicContext | null;
  sensorContext?: {
    soilMoisturePercent?: number | null;
    tankLevelPercent?: number | null;
    tankVolumeLiters?: number | null;
    capturedAt?: string | null;
    deviceUid?: string | null;
  } | null;
}) {
  const requestedMode = normalizeIrrigationMode(input.irrigationMode);
  const fallbackWaterSavingPercent = Math.max(40, Math.min(100, Number(input.waterSavingPercent ?? 70)));
  const agronomicFactor = Math.max(0.65, Math.min(1.35, Number(input.agronomicContext?.adjustment.factor ?? 1)));
  const cropWaterPlan = input.plants.map((plant) => {
    const profile = findCropIrrigationProfile(plant.name);
    const detectedCount = Math.max(0, Number(plant.count ?? 0));
    const count = profile?.useLandAreaByDefault && detectedCount <= 10
      ? Math.max(0, Number(input.areaM2 ?? 0))
      : detectedCount;
    const litersPerUnitPerIrrigation = (profile ? cropIrrigationLiters(profile) : 1.5) * agronomicFactor;
    const intervalDays = profile ? Math.max(1, profile.intervalDays) : 1;
    const dailyLitersPerUnit = litersPerUnitPerIrrigation / intervalDays;
    const appliedModeFactor = modeFactor(profile, requestedMode, fallbackWaterSavingPercent);
    const appliedWaterPercent = Math.round(appliedModeFactor * 100);
    const modeMeta = requestedMode ? IRRIGATION_MODE_GUIDE[requestedMode] : null;

    return {
      name: plant.name,
      count,
      unit: profile?.unit ?? "plant",
      litersPerUnitPerIrrigation,
      intervalDays,
      wateringPercent: profile?.wateringPercent ?? 100,
      waterSavingPercent: appliedWaterPercent,
      irrigationMode: requestedMode ?? "custom_percent",
      irrigationModeLabel: modeMeta?.label ?? `Custom ${fallbackWaterSavingPercent}%`,
      irrigationModeReason: modeMeta?.reason ?? "Custom operator-defined percentage of full crop-water requirement.",
      irrigationModeFactor: appliedModeFactor,
      agronomicFactor,
      agronomicAdjustmentLabel: input.agronomicContext?.adjustment.label ?? "local_baseline",
      dailyLitersPerUnit,
      rawTotalLitersPerIrrigation: litersPerUnitPerIrrigation * count,
      rawDailyAverageLiters: dailyLitersPerUnit * count,
      totalLitersPerIrrigation: litersPerUnitPerIrrigation * count * appliedModeFactor,
      dailyAverageLiters: dailyLitersPerUnit * count * appliedModeFactor,
      season: profile?.season ?? "custom crop profile not configured",
      method: profile?.method ?? "Fallback: 1.5 L per plant per irrigation until admin adds a verified crop profile.",
      source: profile?.source ?? "Manual/unknown crop"
    };
  });

  const rawBaseLiters = cropWaterPlan.reduce((sum, item) => {
    return sum + item.rawDailyAverageLiters;
  }, 0);
  const rawTotalLitersPerIrrigationBeforeRain = cropWaterPlan.reduce((sum, item) => {
    return sum + item.rawTotalLitersPerIrrigation;
  }, 0);
  const baseLiters = cropWaterPlan.reduce((sum, item) => {
    return sum + item.dailyAverageLiters;
  }, 0);
  const totalLitersPerIrrigationBeforeRain = cropWaterPlan.reduce((sum, item) => {
    return sum + item.totalLitersPerIrrigation;
  }, 0);
  const irrigationIntervalDays = cropWaterPlan.length
    ? Math.max(1, Math.min(...cropWaterPlan.map((item) => item.intervalDays)))
    : 1;

  const rainDeductionLiters = Math.max(0, Number(input.forecastRainMm || 0)) * Math.max(0, Number(input.areaM2 || 0));
  const sensorSoilMoisturePercent = Number(input.sensorContext?.soilMoisturePercent);
  const soilMoistureFactor = soilMoistureIrrigationFactor(sensorSoilMoisturePercent);
  const soilMoistureDeductionLiters = Math.max(0, baseLiters - (baseLiters * soilMoistureFactor));
  const totalLitersPerDay = Math.max(0, (baseLiters * soilMoistureFactor) - rainDeductionLiters);
  const totalLitersPerIrrigation = Math.max(0, (totalLitersPerIrrigationBeforeRain * soilMoistureFactor) - rainDeductionLiters);
  const tankAvailableLiters = Number.isFinite(Number(input.tankAvailableLiters))
    ? Math.max(0, Number(input.tankAvailableLiters))
    : null;
  const tankReserveLiters = Number.isFinite(Number(input.tankReserveLiters))
    ? Math.max(0, Number(input.tankReserveLiters))
    : 0;
  const usableTankLiters = tankAvailableLiters === null
    ? null
    : Math.max(0, tankAvailableLiters - tankReserveLiters);
  const executableLiters = usableTankLiters === null
    ? totalLitersPerIrrigation
    : Math.min(totalLitersPerIrrigation, usableTankLiters);
  const tankShortageLiters = usableTankLiters === null
    ? 0
    : Math.max(0, totalLitersPerIrrigation - usableTankLiters);
  const canCompleteIrrigation = tankShortageLiters <= 0.01;
  const recommendedDurationSeconds = input.flowRateLitersPerMinute > 0
    ? Math.ceil((totalLitersPerDay / input.flowRateLitersPerMinute) * 60)
    : 0;
  const recommendedIrrigationDurationSeconds = input.flowRateLitersPerMinute > 0
    ? Math.ceil((executableLiters / input.flowRateLitersPerMinute) * 60)
    : 0;
  const averageModeFactor = cropWaterPlan.length
    ? cropWaterPlan.reduce((sum, item) => sum + Number(item.irrigationModeFactor ?? 0), 0) / cropWaterPlan.length
    : requestedMode
      ? IRRIGATION_MODE_GUIDE[requestedMode].factor
      : fallbackWaterSavingPercent / 100;

  return {
    irrigationMode: requestedMode ?? "custom_percent",
    irrigationModeLabel: requestedMode ? IRRIGATION_MODE_GUIDE[requestedMode].label : `Custom ${fallbackWaterSavingPercent}%`,
    irrigationModeReason: requestedMode ? IRRIGATION_MODE_GUIDE[requestedMode].reason : "Custom operator-defined percentage of full crop-water requirement.",
    irrigationModeSource: IRRIGATION_MODE_SOURCE,
    agronomicAdjustment: input.agronomicContext
      ? {
        factor: agronomicFactor,
        label: input.agronomicContext.adjustment.label,
        reasons: input.agronomicContext.adjustment.reasons,
        openMeteo: input.agronomicContext.openMeteo,
        soilGrids: input.agronomicContext.soilGrids
      }
      : {
        factor: 1,
        label: "local_baseline",
        reasons: ["لم يتم جلب بيانات Open-Meteo/SoilGrids؛ استخدمت المنصة القيم المحلية فقط."],
        openMeteo: null,
        soilGrids: null
      },
    waterSavingPercent: Math.round(averageModeFactor * 100),
    waterSavingFactor: averageModeFactor,
    calculationMethod: FAO_METHOD,
    policyContext: IRAQ_WATER_POLICY,
    rawBaseLiters,
    rawTotalLitersPerIrrigation: rawTotalLitersPerIrrigationBeforeRain,
    baseLiters,
    dailyAverageLiters: totalLitersPerDay,
    rainDeductionLiters,
    soilMoisturePercent: Number.isFinite(sensorSoilMoisturePercent) ? sensorSoilMoisturePercent : null,
    soilMoistureAdjustmentFactor: soilMoistureFactor,
    soilMoistureDeductionLiters,
    sensorContext: input.sensorContext ?? null,
    totalLitersPerDay,
    totalLitersPerIrrigation,
    executableLiters,
    tankAvailableLiters,
    tankReserveLiters,
    usableTankLiters,
    tankShortageLiters,
    canCompleteIrrigation,
    irrigationIntervalDays,
    cropWaterPlan,
    recommendedDurationSeconds,
    recommendedIrrigationDurationSeconds
  };
}
