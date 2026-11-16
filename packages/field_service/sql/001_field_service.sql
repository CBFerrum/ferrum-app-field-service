-- Field service: the database guarantees that keep schedules sound whatever the application does,
-- and the indexes its upkeep reads.

-- No technician can be booked twice: the active rows of appointments (busy) of one technician
-- never overlap. Back-to-back slots ([10:00, 12:00) then [12:00, 14:00)) are fine.
alter table e_service_appointment__technicians
  add constraint fs_technician_no_overlap
  exclude using gist (tenant_id with =, technician with =, tstzrange(slot_start, slot_end, '[)') with &&) where (busy);

-- A busy row always carries a real time range (an open range would block the technician forever).
alter table e_service_appointment__technicians
  add constraint fs_busy_slot_valid
  check (not busy or (technician is not null and slot_start is not null and slot_end is not null and slot_end > slot_start));

-- Maintenance looks for open work orders (SLA) and due contracts every minute.
create index if not exists fs_open_work_orders on e_service_work_order (tenant_id, status) where docstatus = 0;
create index if not exists fs_due_contracts on e_service_contract (tenant_id, next_due_date) where docstatus = 1 and status = 'Active';
