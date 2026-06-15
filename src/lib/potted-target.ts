function rangeAverage(range: unknown) {
  if (!range || typeof range !== "object") return null;
  const min = Number((range as { min?: unknown }).min);
  const max = Number((range as { max?: unknown }).max);
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) return (min + max) / 2;
  if (Number.isFinite(max) && max > 0) return max;
  if (Number.isFinite(min) && min > 0) return min;
  return null;
}

export function estimatePottedTargetAreaM2(analysis: unknown) {
  const record = analysis && typeof analysis === "object" ? analysis as any : {};
  const potDiameterCm = rangeAverage(record.container?.estimated_top_diameter_cm);
  const canopyWidthCm = rangeAverage(record.plant?.canopy_width_cm);
  const targetDiameterCm = Math.max(
    Number(potDiameterCm ?? 0),
    Number(canopyWidthCm ?? 0),
    25
  );
  const radiusM = Math.max(0.12, Math.min(1.2, (targetDiameterCm / 100) / 2));
  const areaM2 = Math.PI * radiusM * radiusM;

  return Number(Math.max(0.05, Math.min(4, areaM2)).toFixed(3));
}

export function squareGeojsonAroundPoint(input: {
  lat: number;
  lon: number;
  areaM2: number;
}) {
  const lat = Number.isFinite(input.lat) ? input.lat : 33.3152;
  const lon = Number.isFinite(input.lon) ? input.lon : 44.3661;
  const sideM = Math.sqrt(Math.max(0.05, input.areaM2));
  const halfSideM = sideM / 2;
  const latDelta = halfSideM / 111_320;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const lonDelta = halfSideM / (111_320 * cosLat);

  return {
    type: "Polygon",
    coordinates: [[
      [lon - lonDelta, lat - latDelta],
      [lon + lonDelta, lat - latDelta],
      [lon + lonDelta, lat + latDelta],
      [lon - lonDelta, lat + latDelta],
      [lon - lonDelta, lat - latDelta]
    ]]
  };
}

export function pottedPlantNameFromAnalysis(analysis: unknown, fallback: string) {
  const record = analysis && typeof analysis === "object" ? analysis as any : {};
  return String(record.plant?.arabic_name || record.plant?.name || fallback || "نبات مفرد").trim();
}
