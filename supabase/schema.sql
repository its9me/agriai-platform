create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  role text not null default 'farmer' check (role in ('farmer', 'admin', 'operator')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.lands (
  id bigint generated always as identity primary key,
  owner_id uuid references public.profiles(id) on delete set null,
  name text not null,
  crop_hint text,
  boundary_geojson jsonb not null,
  boundary_geom extensions.geometry(Polygon, 4326) not null,
  centroid extensions.geometry(Point, 4326) generated always as (
    extensions.ST_Centroid(boundary_geom)
  ) stored,
  area_m2 numeric generated always as (
    extensions.ST_Area(boundary_geom::extensions.geography)
  ) stored,
  auto_irrigation_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lands_boundary_gix on public.lands using gist(boundary_geom);

create table if not exists public.land_memberships (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'farmer' check (role in ('farmer', 'operator', 'viewer')),
  created_at timestamptz not null default now(),
  unique (land_id, profile_id)
);

create index if not exists land_memberships_profile_idx
  on public.land_memberships(profile_id, created_at desc);

create index if not exists land_memberships_land_idx
  on public.land_memberships(land_id, created_at desc);

create table if not exists public.imagery (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  uploaded_by uuid references public.profiles(id) on delete set null,
  image_url text not null,
  source text not null default 'phone' check (source in ('phone', 'drone', 'manual')),
  captured_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.ai_analyses (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  imagery_id bigint references public.imagery(id) on delete set null,
  model_name text not null,
  plant_summary jsonb not null,
  pest_summary jsonb not null,
  weather_snapshot jsonb not null,
  raw_ai_json jsonb not null,
  confidence numeric check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now()
);

create table if not exists public.land_plants (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  name text not null,
  count integer not null check (count >= 0),
  growth_stage text not null default 'unknown',
  notes text,
  source text not null default 'manual' check (source in ('manual', 'image_ai', 'sensor', 'import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists land_plants_land_idx
  on public.land_plants(land_id, created_at desc);

create table if not exists public.irrigation_recommendations (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  ai_analysis_id bigint references public.ai_analyses(id) on delete set null,
  total_liters_per_day numeric not null check (total_liters_per_day >= 0),
  rain_deduction_liters numeric not null default 0 check (rain_deduction_liters >= 0),
  recommended_duration_seconds integer not null check (recommended_duration_seconds >= 0),
  flow_rate_liters_per_minute numeric not null default 10,
  reason text,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'sent_to_iot', 'completed', 'cancelled')
  ),
  created_at timestamptz not null default now()
);

create table if not exists public.iot_devices (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  device_uid text not null unique,
  mqtt_topic_command text not null,
  mqtt_topic_ack text not null,
  relay_pin integer not null default 26,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.iot_commands (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  device_id bigint references public.iot_devices(id) on delete set null,
  recommendation_id bigint references public.irrigation_recommendations(id) on delete set null,
  command_uuid uuid not null default gen_random_uuid(),
  payload jsonb not null,
  status text not null default 'queued' check (
    status in ('queued', 'published', 'acknowledged', 'failed', 'expired')
  ),
  published_at timestamptz,
  acknowledged_at timestamptz,
  ack_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.iot_telemetry (
  id bigint generated always as identity primary key,
  land_id bigint not null references public.lands(id) on delete cascade,
  device_id bigint references public.iot_devices(id) on delete set null,
  device_uid text not null,
  soil_moisture_percent numeric check (soil_moisture_percent >= 0 and soil_moisture_percent <= 100),
  temperature_c numeric,
  humidity_percent numeric check (humidity_percent >= 0 and humidity_percent <= 100),
  flow_liters_per_minute numeric check (flow_liters_per_minute >= 0),
  tank_level_percent numeric check (tank_level_percent >= 0 and tank_level_percent <= 100),
  tank_volume_liters numeric check (tank_volume_liters >= 0),
  tank_capacity_liters numeric check (tank_capacity_liters > 0),
  tank_sensor_source text,
  valve_state text not null default 'unknown' check (valve_state in ('ON', 'OFF', 'unknown')),
  battery_percent numeric check (battery_percent >= 0 and battery_percent <= 100),
  raw_payload jsonb not null default '{}',
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists iot_telemetry_land_created_idx on public.iot_telemetry(land_id, created_at desc);
create index if not exists iot_telemetry_device_created_idx on public.iot_telemetry(device_uid, created_at desc);

create table if not exists public.potted_plants (
  id bigint generated always as identity primary key,
  owner_id uuid references public.profiles(id) on delete set null,
  linked_land_id bigint references public.lands(id) on delete set null,
  name text not null,
  location_label text,
  image_url text not null,
  image_metadata jsonb not null default '{}',
  target_boundary_geojson jsonb not null default '{}',
  target_area_m2 numeric check (target_area_m2 >= 0),
  analysis_json jsonb not null default '{}',
  command_preview jsonb not null default '{}',
  sensor_context jsonb,
  flow_rate_liters_per_minute numeric not null default 10 check (flow_rate_liters_per_minute > 0),
  notes text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists potted_plants_owner_idx
  on public.potted_plants(owner_id, created_at desc);

create index if not exists potted_plants_linked_land_idx
  on public.potted_plants(linked_land_id, created_at desc);

create table if not exists public.field_notes (
  id bigint generated always as identity primary key,
  land_id bigint references public.lands(id) on delete set null,
  note text not null,
  triage_json jsonb not null,
  weather_snapshot jsonb,
  source text not null default 'manual' check (source in ('manual', 'operator', 'farmer')),
  created_at timestamptz not null default now()
);

create index if not exists field_notes_land_idx on public.field_notes(land_id, created_at desc);

create table if not exists public.ai_action_plans (
  id bigint generated always as identity primary key,
  land_id bigint references public.lands(id) on delete cascade,
  plan_json jsonb not null,
  weather_snapshot jsonb,
  status text not null default 'draft' check (status in ('draft', 'approved', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists ai_action_plans_land_idx on public.ai_action_plans(land_id, created_at desc);

create table if not exists public.ai_decisions (
  id bigint generated always as identity primary key,
  land_id bigint references public.lands(id) on delete cascade,
  decision_json jsonb not null,
  evidence_counts jsonb not null default '{}'::jsonb,
  weather_snapshot jsonb,
  status text not null default 'generated' check (status in ('generated', 'reviewed', 'approved', 'executed', 'dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists ai_decisions_land_idx on public.ai_decisions(land_id, created_at desc);

create table if not exists public.irrigation_schedules (
  id bigint generated always as identity primary key,
  land_id bigint references public.lands(id) on delete cascade,
  schedule_json jsonb not null,
  evidence_counts jsonb not null default '{}'::jsonb,
  weather_snapshot jsonb,
  source text not null default 'ai' check (source in ('ai', 'rules_fallback')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent_to_iot', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists irrigation_schedules_land_idx on public.irrigation_schedules(land_id, created_at desc);

create table if not exists public.field_work_orders (
  id bigint generated always as identity primary key,
  land_id bigint references public.lands(id) on delete cascade,
  task_json jsonb not null,
  source text not null default 'ai' check (source in ('ai', 'rules_fallback')),
  status text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'done', 'cancelled')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  owner_role text not null default 'operator' check (owner_role in ('farmer', 'operator', 'manager', 'hardware')),
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists field_work_orders_land_idx on public.field_work_orders(land_id, created_at desc);
create index if not exists field_work_orders_status_idx on public.field_work_orders(status, priority, due_at);

create or replace function public.insert_land_from_geojson(
  land_name text,
  crop text,
  geojson jsonb,
  auto_irrigation boolean default false
)
returns public.lands
language plpgsql
security definer
as $$
declare
  inserted_land public.lands;
begin
  insert into public.lands (
    owner_id,
    name,
    crop_hint,
    boundary_geojson,
    boundary_geom,
    auto_irrigation_enabled
  )
  values (
    auth.uid(),
    land_name,
    crop,
    geojson,
    extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(geojson::text), 4326),
    auto_irrigation
  )
  returning * into inserted_land;

  return inserted_land;
end;
$$;
