export type OpenMeteoAgroSnapshot = {
  source: "open_meteo";
  et0ForecastMm: number;
  et0DailyAverageMm: number;
  precipitationForecastMm: number;
  soilMoisture0To9cm: number | null;
  vaporPressureDeficitKpa: number | null;
  generatedAt: string;
};

export type SoilGridsSnapshot = {
  source: "soilgrids";
  textureClass: string | null;
  sandPercent: number | null;
  siltPercent: number | null;
  clayPercent: number | null;
  phH2o: number | null;
  irrigationFactor: number;
  intervalAdjustmentDays: number;
  note: string;
};

export type AgronomicContext = {
  openMeteo: OpenMeteoAgroSnapshot | null;
  soilGrids: SoilGridsSnapshot | null;
  adjustment: {
    factor: number;
    label: string;
    reasons: string[];
  };
};

const cache = new Map<string, { expiresAt: number; value: AgronomicContext }>();

function average(values: unknown[]) {
  const valid = values.map(Number).filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function sum(values: unknown[]) {
  return values.map(Number).filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function clamp(min: number, max: number, value: number) {
  return Math.max(min, Math.min(max, value));
}

async function getOpenMeteoAgro(lat: number, lon: number): Promise<OpenMeteoAgroSnapshot | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("daily", "et0_fao_evapotranspiration,precipitation_sum");
  url.searchParams.set("hourly", "soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,vapour_pressure_deficit");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "7");

  const response = await fetch(url, { next: { revalidate: 60 * 60 * 3 } });
  if (!response.ok) return null;

  const data = await response.json();
  const dailyEt0 = Array.isArray(data.daily?.et0_fao_evapotranspiration)
    ? data.daily.et0_fao_evapotranspiration
    : [];
  const precipitation = Array.isArray(data.daily?.precipitation_sum)
    ? data.daily.precipitation_sum
    : [];
  const soilMoisture = [
    ...(Array.isArray(data.hourly?.soil_moisture_0_to_1cm) ? data.hourly.soil_moisture_0_to_1cm : []),
    ...(Array.isArray(data.hourly?.soil_moisture_1_to_3cm) ? data.hourly.soil_moisture_1_to_3cm : []),
    ...(Array.isArray(data.hourly?.soil_moisture_3_to_9cm) ? data.hourly.soil_moisture_3_to_9cm : [])
  ];
  const vpd = Array.isArray(data.hourly?.vapour_pressure_deficit)
    ? data.hourly.vapour_pressure_deficit
    : [];
  const et0ForecastMm = sum(dailyEt0);
  const et0DailyAverageMm = average(dailyEt0) ?? 0;

  return {
    source: "open_meteo",
    et0ForecastMm,
    et0DailyAverageMm,
    precipitationForecastMm: sum(precipitation),
    soilMoisture0To9cm: average(soilMoisture),
    vaporPressureDeficitKpa: average(vpd),
    generatedAt: new Date().toISOString()
  };
}

function soilValue(layer: any, depthLabel: string) {
  const depth = layer?.depths?.find((item: any) => item?.label === depthLabel) ?? layer?.depths?.[0];
  const raw = Number(depth?.values?.mean);
  const divisor = Number(layer?.unit_measure?.d_factor ?? 1) || 1;
  return Number.isFinite(raw) ? raw / divisor : null;
}

function classifyTexture(input: { sand: number | null; silt: number | null; clay: number | null }) {
  const sand = input.sand ?? 0;
  const silt = input.silt ?? 0;
  const clay = input.clay ?? 0;

  if (sand >= 70) {
    return {
      textureClass: "sandy",
      irrigationFactor: 1.1,
      intervalAdjustmentDays: -1,
      note: "تربة رملية: الماء ينفذ بسرعة، لذلك يفضل دفعات أصغر ومتقاربة."
    };
  }

  if (clay >= 40) {
    return {
      textureClass: "clay",
      irrigationFactor: 0.92,
      intervalAdjustmentDays: 1,
      note: "تربة طينية: تحتفظ بالماء أكثر، لذلك نقلل الدفعة قليلا ونباعد الري."
    };
  }

  if (silt >= 45) {
    return {
      textureClass: "silty_loam",
      irrigationFactor: 0.98,
      intervalAdjustmentDays: 0,
      note: "تربة غرينية/لومية: احتفاظ متوسط بالماء."
    };
  }

  return {
    textureClass: "loam",
    irrigationFactor: 1,
    intervalAdjustmentDays: 0,
    note: "تربة لومية تقريبية: لا يوجد تعديل كبير على كمية الري."
  };
}

async function getSoilGrids(lat: number, lon: number): Promise<SoilGridsSnapshot | null> {
  const url = new URL("https://rest.isric.org/soilgrids/v2.0/properties/query");
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("lat", String(lat));
  for (const property of ["sand", "silt", "clay", "phh2o"]) {
    url.searchParams.append("property", property);
  }
  for (const depth of ["0-5cm", "5-15cm"]) {
    url.searchParams.append("depth", depth);
  }
  url.searchParams.set("value", "mean");

  const response = await fetch(url, { next: { revalidate: 60 * 60 * 24 * 7 } });
  if (!response.ok) return null;

  const data = await response.json();
  const layers = Array.isArray(data.properties?.layers) ? data.properties.layers : [];
  const byName = new Map(layers.map((layer: any) => [String(layer.name), layer]));
  const sand = soilValue(byName.get("sand"), "0-5cm");
  const silt = soilValue(byName.get("silt"), "0-5cm");
  const clay = soilValue(byName.get("clay"), "0-5cm");
  const phH2o = soilValue(byName.get("phh2o"), "0-5cm");

  if (sand === null && silt === null && clay === null && phH2o === null) {
    return {
      source: "soilgrids",
      textureClass: null,
      sandPercent: null,
      siltPercent: null,
      clayPercent: null,
      phH2o: null,
      irrigationFactor: 1,
      intervalAdjustmentDays: 0,
      note: "SoilGrids لم يرجع خواص تربة لهذه النقطة؛ تم إبقاء حساب الري بدون تعديل تربة."
    };
  }

  const texture = classifyTexture({ sand, silt, clay });
  return {
    source: "soilgrids",
    textureClass: texture.textureClass,
    sandPercent: sand,
    siltPercent: silt,
    clayPercent: clay,
    phH2o,
    irrigationFactor: texture.irrigationFactor,
    intervalAdjustmentDays: texture.intervalAdjustmentDays,
    note: texture.note
  };
}

function buildAdjustment(openMeteo: OpenMeteoAgroSnapshot | null, soilGrids: SoilGridsSnapshot | null) {
  const reasons: string[] = [];
  let factor = 1;

  if (openMeteo?.et0DailyAverageMm) {
    const et0Factor = clamp(0.82, 1.25, openMeteo.et0DailyAverageMm / 5.5);
    factor *= et0Factor;
    reasons.push(`ET0 ${openMeteo.et0DailyAverageMm.toFixed(1)} mm/day عدّل الاحتياج ×${et0Factor.toFixed(2)}.`);
  }

  if (openMeteo?.soilMoisture0To9cm !== null && openMeteo?.soilMoisture0To9cm !== undefined) {
    const moisture = openMeteo.soilMoisture0To9cm;
    const moistureFactor = moisture < 0.12
      ? 1.12
      : moisture < 0.18
        ? 1.06
        : moisture > 0.32
          ? 0.9
          : moisture > 0.25
            ? 0.95
            : 1;
    factor *= moistureFactor;
    reasons.push(`رطوبة التربة المتوقعة ${moisture.toFixed(2)} m3/m3 عدلت ×${moistureFactor.toFixed(2)}.`);
  }

  if (soilGrids) {
    factor *= soilGrids.irrigationFactor;
    reasons.push(`${soilGrids.note} عامل التربة ×${soilGrids.irrigationFactor.toFixed(2)}.`);
  }

  const safeFactor = clamp(0.65, 1.35, factor);
  return {
    factor: safeFactor,
    label: safeFactor > 1.05 ? "زيادة محسوبة" : safeFactor < 0.95 ? "تقليل محسوب" : "بدون تعديل كبير",
    reasons: reasons.length ? reasons : ["لا توجد بيانات زراعية خارجية كافية؛ الحساب بقي على القيم المحلية."]
  };
}

export async function getAgronomicContext(lat: number, lon: number): Promise<AgronomicContext> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [openMeteo, soilGrids] = await Promise.all([
    getOpenMeteoAgro(lat, lon).catch(() => null),
    getSoilGrids(lat, lon).catch(() => null)
  ]);

  const value = {
    openMeteo,
    soilGrids,
    adjustment: buildAdjustment(openMeteo, soilGrids)
  };
  cache.set(key, { expiresAt: Date.now() + 1000 * 60 * 60 * 3, value });
  return value;
}
