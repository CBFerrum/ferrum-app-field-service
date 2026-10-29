-- Field service: the database guarantees that keep schedules and customer links sound whatever
-- the application does, and the per-tenant key that signs customer tracking links.

-- No technician can be booked twice: the active rows of appointments (busy) of one technician
-- never overlap. Back-to-back slots ([10:00, 12:00) then [12:00, 14:00)) are fine.
alter table e_service_appointment__technicians
  add constraint fs_technician_no_overlap
  exclude using gist (tenant_id with =, technician with =, tstzrange(slot_start, slot_end, '[)') with &&) where (busy);

-- A busy row always carries a real time range (an open range would block the technician forever).
alter table e_service_appointment__technicians
  add constraint fs_busy_slot_valid
  check (not busy or (technician is not null and slot_start is not null and slot_end is not null and slot_end > slot_start));

-- The key signing tracking links, kept out of every entity (so no API, export or audit trail can
-- reveal it).
create table field_service_secret (
  tenant_id uuid primary key references tenant(id) on delete cascade,
  secret bytea not null check (length(secret) = 32),
  created_at timestamptz not null default now()
);
alter table field_service_secret enable row level security;
alter table field_service_secret force row level security;
create policy tenant_isolation on field_service_secret
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

-- Maintenance looks for open work orders (SLA) and due contracts every minute.
create index if not exists fs_open_work_orders on e_service_work_order (tenant_id, status) where docstatus = 0;
create index if not exists fs_due_contracts on e_service_contract (tenant_id, next_due_date) where docstatus = 1 and status = 'Active';
