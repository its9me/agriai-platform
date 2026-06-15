import { requireEnv } from "./env";
import { getAgronomicContext, type AgronomicContext } from "./agro-data";

export type WeatherSnapshot = {
  currentRainMm: number;
  forecastRainMm: number;
  openWeatherForecastRainMm: number;
  forecast: Array<{
    at: string;
    tempC: number;
    humidity: number;
    rainMm: number;
  }>;
  agronomic: AgronomicContext | null;
};

export async function getWeather(lat: number, lon: number): Promise<WeatherSnapshot> {
  const key = requireEnv("OPENWEATHER_API_KEY");
  const url = new URL("https://api.openweathermap.org/data/2.5/forecast");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("units", "metric");
  url.searchParams.set("appid", key);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenWeather failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const forecast = data.list.map((item: any) => ({
    at: item.dt_txt,
    tempC: item.main.temp,
    humidity: item.main.humidity,
    rainMm: item.rain?.["3h"] ?? 0
  }));

  const agronomic = await getAgronomicContext(lat, lon).catch(() => null);
  const openWeatherForecastRainMm = forecast.reduce((sum: number, item: { rainMm: number }) => sum + item.rainMm, 0);
  const openMeteoRainMm = Number(agronomic?.openMeteo?.precipitationForecastMm ?? 0);

  return {
    currentRainMm: forecast[0]?.rainMm ?? 0,
    forecastRainMm: Math.max(openWeatherForecastRainMm, openMeteoRainMm),
    openWeatherForecastRainMm,
    forecast,
    agronomic
  };
}
