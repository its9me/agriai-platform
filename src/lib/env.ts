export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function publicConfig() {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    defaultLat: Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_LAT ?? 33.3152),
    defaultLng: Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_LNG ?? 44.3661)
  };
}
