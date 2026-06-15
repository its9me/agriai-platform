alter table public.iot_devices
  add column if not exists hardware_profile jsonb not null default '{}',
  add column if not exists pump_flow_liters_per_minute numeric check (pump_flow_liters_per_minute is null or pump_flow_liters_per_minute > 0),
  add column if not exists soil_sensor_model text,
  add column if not exists tank_sensor_model text,
  add column if not exists relay_model text,
  add column if not exists pump_model text,
  add column if not exists notes text,
  add column if not exists updated_at timestamptz not null default now();

