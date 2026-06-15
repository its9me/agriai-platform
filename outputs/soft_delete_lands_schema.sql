-- Safe land deletion for AgriAI.
-- This keeps lands as archived rows so ESP32 devices, telemetry, imagery, and irrigation history are not deleted.

alter table public.lands
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete set null,
  add column if not exists delete_reason text;

create index if not exists lands_deleted_at_idx
  on public.lands(deleted_at, created_at desc);

create index if not exists lands_active_created_idx
  on public.lands(created_at desc)
  where deleted_at is null;
