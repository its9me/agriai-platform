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

alter table public.potted_plants
  add column if not exists target_boundary_geojson jsonb not null default '{}';

alter table public.potted_plants
  add column if not exists target_area_m2 numeric check (target_area_m2 >= 0);
