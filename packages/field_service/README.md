# Field Service — package `field_service`

Requests, work orders, technicians, appointments, dispatch, parts, time, signatures, contracts and
invoicing. Depends on `core`, `selling`, `inventory` and `accounting`; logic in this repository's
`src/`. Stock moves only through the platform's stock engine (a Material Issue `StockEntry`),
invoices only through the selling engine (a draft `SalesInvoice` priced by `pricing::calculate`).

Everything is operable through the generic records API (`/api/v1/{Entity}`, actions at
`POST /api/v1/{Entity}/{id}/actions/{action}`) and MCP. The package's own endpoints are the
dispatch board (an aggregated read) and the customers' public request and tracking endpoints.

## Roles

| Role | Can |
|---|---|
| Service Manager | everything below, plus settings, technicians (including their costs), checklist templates, contracts (submit/cancel), reversing a completion (cancel), and invoicing (needs Sales Invoice create; the role grants it) |
| Dispatcher | requests (create, convert, reject), work orders (create, plan, schedule, dispatch, cancel, complete on a technician's behalf), appointments, installed base; reads settings, technicians, contracts |
| Technician | **own** work orders and appointments only — those they are assigned to (the work order's crew, the appointment's technicians): travel, arrival, checklist, parts, labour, expenses, notes, signature, completion; files service requests (sees their own); reads customers, items, warehouses, equipment |

Field groups: `planning` (who/what/where/when of a work order: company, customer, equipment, site,
territory, type, priority, description, reported time, preferred time, duration, required skills,
checklist template) — managers and dispatchers write it, technicians read it; `costing` (technician
cost per hour, labour cost rates, part costs, work order labour/parts cost) — managers only.

## Setting up

1. **Field Service Settings** (`FieldServiceSettings`, one per workspace; defaults apply before it exists):

   | Field | Meaning (default) |
   |---|---|
   | `labour_item` | non-stock service item invoiced for labour |
   | `expense_item` | non-stock service item invoiced for billable expenses |
   | `labour_increment_minutes` | labour is billed in started steps of this many minutes (1) |
   | `travel_speed_kmh` | average speed for travel estimates over the straight-line (haversine) distance; lower it to allow for roads and traffic (40) |
   | `default_duration_minutes` | job length when a work order or contract gives none (60) |
   | `default_warehouse` | where parts come from when the technician has no van warehouse |
   | `require_checklist` | required checklist items must be done before completion (on) |
   | `require_signature` | completion needs the customer's signature image and signer name (on) |
   | `auto_invoice` | create the draft invoice on completion (off); if the work order cannot be invoiced (nothing billable, an item missing here) it still completes and the completing user is told why |
   | `notify_customer` | with the Mail app: email customers the visit window, an on-the-way notice, request confirmations and tracking links (on) |
   | `public_requests` | accept requests on the public endpoint (off) |
   | `tracking_link_days` | validity of customer tracking links (30) |
   | `sla_targets` | per priority: `response_hours` (to arrival on site), `resolution_hours` (to completion); one row per priority, resolution ≥ response |
   | `default_working_hours` | `weekday`, `start_time`, `end_time` (HH:MM, 24:00 = midnight; a night shift is one row per day) for technicians without their own; none at all = round the clock |

2. **Service Territories** (`ServiceTerritory`), **Service Skills** (`ServiceSkill`).
3. **Technicians** (`Technician`): `technician_name`, `user_email` (the user they sign in with —
   it must exist; it is what makes work orders and appointments theirs), `active`, `phone`,
   `territory`, `skills` (`skill`, `level`), `bill_rate` and `hourly_cost` (per hour, company
   currency), `time_zone` (IANA, e.g. `Europe/London`; empty = the workspace's), `working_hours`
   (as above; empty = the settings' defaults), `home_latitude`/`home_longitude`, `van_warehouse`.
4. **Checklist Templates** (`ServiceChecklistTemplate`): `template_name`, `items` (`task`, `required`).
5. **Customer Equipment** (`CustomerEquipment`, the installed base): `customer`, `item`,
   `serial_no` (unique per item), `status`, `install_date`, `warranty_end`,
   `warranty_covers_labour` (on), `site_address`, `latitude`/`longitude` (both or neither),
   `territory`; `equipment_name` and `last_service_date` are set by the app.

## Service Request (`ServiceRequest`, `FSR-YYYY-#####`)

From staff, the phone, email, the helpdesk or customers. Fields: `subject`, `description`,
`source` (Staff, Phone, Email, Helpdesk, Customer Portal), `requested_at` (default now; not in the
future, fixed once saved — the work order's SLA counts from it), `customer`, contact
(`contact_name`, `contact_email`, `contact_phone`), `equipment`, site (`site_address`,
`latitude`, `longitude`, `territory`), `work_type` (Repair, Installation, Maintenance, Inspection),
`priority` (Low, Medium, High, Urgent), `preferred_start`, `helpdesk_ticket`; set by the app:
`status` (Open, Converted, Rejected), `work_order`, `rejection_reason`.

On save: the equipment fills the customer and site; a contact email that belongs to exactly one
customer sets the customer; the customer fills the contact email and phone. `helpdesk_ticket`
(a ticket id or number) copies the ticket's customer, contact, subject, description, priority
and (by serial number) equipment when the Helpdesk app is installed; otherwise it is kept as a
reference. Converted and rejected requests are final.

| Action | Who | Params | Returns |
|---|---|---|---|
| `make_work_order` | read access + Service Work Order create | `{company?}` | `{entity, id, number}` of the work order (customer, contact, equipment, site, type, priority, description, preferred time and `reported_at = requested_at` carried over); the request becomes Converted. Refused without a customer, and once converted |
| `reject` | dispatchers, managers | `{reason}` (required, ≤ 2000) | `{status: "Rejected", customer_emailed}`; whoever filed it is told |
| `tracking_link` | read access | `{send?: true}` | `{path, url, expires_at, emailed}`: a new signed link (`url` is absolute when the Mail app's public URL is set); `send` emails it to the contact (needs the Mail app) |

## Service Work Order (`ServiceWorkOrder`, `FSWO-YYYY-#####`, submittable)

**Fields.** `company`, `customer`, contact, `equipment` (must be the customer's; fills `item`,
`serial_no` and — where empty — site and territory; without equipment the customer's shipping or
billing address is the site), `work_type`, `priority`, `description`, `reported_at` (default now,
not in the future, fixed once saved), `preferred_start`, `estimated_duration_minutes` (default:
the contract's, else the settings'), `required_skills`, `checklist_template`, `checklist`
(`task`, `required`, `done`; `done_by`/`done_at` recorded by the server), `parts` (`item`, `qty`,
`warehouse` — default: the user's van, the lead technician's van, the settings' warehouse —
`serial_no` one per line, `batch_no`, `warranty`; `cost` after completion), `labour`
(`technician` — default: you — `from_time`, `to_time`, `billable`; `hours`, `bill_rate`,
`cost_rate` set by the app), `expenses` (`expense_type`, `description`, `amount`, `billable`),
`work_notes`, `customer_signature` (`/files/<id>` of an uploaded image), `signed_by`
(`signed_at` set by the app). Photos and other files are attachments: `POST /api/files` with
`entity=ServiceWorkOrder` and `record_id`.

**Derived on every save** (read-only): `status`, `crew` (every technician on a non-cancelled
appointment — they see the work order), `current_appointment`, `scheduled_start`/`scheduled_end`,
`travel_started_at`, `arrived_at` (first arrival), `completed_at`, `cancelled_at`,
`cancellation_reason`, `visits`, `first_time_fix`, the SLA fields, `service_contract` (the
customer's submitted contract for this equipment or all their equipment whose term includes the
reported day; a planned visit keeps its contract), `contract_due_date` (planned visits),
`under_warranty` (`warranty_end` on or after the reported day), `parts_covered` (warranty, or the
contract covers parts), `labour_covered` (warranty that covers labour, or the contract covers
labour), totals (`labour_hours`, `billable_hours`, `labour_cost`, `parts_cost`, `expense_total`),
`stock_entry`, `sales_invoice`.

**Status.** New → Scheduled → Dispatched → En Route → On Site follows the current appointment
(the most advanced active one); without an active appointment the work order is New. Completed and
Invoiced are submitted states; Cancelled is final (a cancelled draft cannot be edited).

**SLA.** The clock starts at `reported_at` (a planned visit: midnight of its due day in the
workspace's zone) and runs in calendar hours. Targets: the contract's `sla_response_hours` /
`sla_resolution_hours` when set (0 = use the priority's), else the settings' targets for the
priority; no target, no verdict. Response is met by arrival on site, resolution by completion,
each by its deadline; a pending deadline past due is breached (`response_breached`,
`resolution_breached`). `sla_status`: On Track, At Risk (a pending deadline with under a quarter
of its window left), Breached, Met. Cancelling stops the clock. Maintenance refreshes the verdicts.

**Labour hours** are whole started minutes rounded up to the billing step, in hours to 2 decimals
(the invoiced quantity, so the invoice line recomputes exactly). Labour is recorded for crew
members only, by themselves (dispatchers and managers for anyone); the bill and cost rates are the
technician's when the line was entered.

| Action | Who | Params | Returns / effect |
|---|---|---|---|
| `suggest_technicians` | dispatchers, managers | `{start?, end? \| duration_minutes?}` (default slot: the scheduled one, else the preferred time, else the next quarter hour) | `{work_order, start, end, technicians: [{technician, technician_name, eligible, score, distance_km, travel_minutes, travel_from, territory, territory_name, within_working_hours, jobs_that_day, reasons: [...]}]}`, eligible first, then score, travel, name. Ineligible: missing required skills, or already booked in the slot. Score 0–100: same territory 30 (work order without territory 15), within working hours 20, travel up to 40 (0 after two hours; 20 without coordinates), workload 10 − 3 per other job that day, −20 when the technician cannot make it in time after the previous job. Travel starts from the previous job's site that day, else home |
| `schedule` | dispatchers, managers | `{technicians: [id] \| technician: id, start, end? \| duration_minutes?, notes?}` (1–20 technicians) | `{entity, id, number, scheduled_start, scheduled_end, appointment_status, status}`. Moves the current appointment while it is Scheduled or Dispatched (a moved dispatched appointment must be dispatched again); while a technician is En Route or On Site that visit ends as **Cannot Complete** and a new one is planned (a revisit); otherwise creates an appointment. Refused when a technician is booked (see below) |
| `dispatch` | dispatchers, managers | — | `{status, appointment, customer_emailed}`: Scheduled → Dispatched; the technicians get an in-app notification; the customer an email with the window and tracking link (Mail app, `notify_customer`) |
| `start_travel` | the crew, dispatchers | — | Dispatched → En Route; the customer is emailed that the technician is on the way |
| `arrive` | the crew, dispatchers | — | Dispatched or En Route → On Site; the first arrival meets or misses the response target |
| `complete` | submit permission (the crew, dispatchers, managers) | — | `{status, stock_entry, sales_invoice, first_time_fix}`. Same as `POST .../submit`. Requires On Site; with the settings, every required checklist task done (row errors) and the signature image plus signer; stock parts need a warehouse, serial numbers matching the quantity, batch numbers for batch items and enough stock (row errors: `not enough stock in Van A: 2 available, 3 needed`; skipped when the company allows negative stock). Then the parts leave stock on a submitted Material Issue (offset to cost of goods sold, valued by the stock engine; `cost` written back), the on-site visit becomes Completed (other open visits Cancelled), the equipment's `last_service_date` is set and — with `auto_invoice` — the invoice drafted. The work order is frozen |
| `cancel_work_order` | dispatchers, managers | `{reason?}` | `{status: "Cancelled"}`; open appointments are cancelled (their time freed), dispatched technicians are told, the SLA clock stops |
| `create_invoice` | read access + Sales Invoice create | — | `{entity, id, number}` of a **draft** Sales Invoice; the work order becomes Invoiced. See *Invoicing* |

Cancelling a **completed** work order (`POST .../cancel`, Service Manager) returns its parts to
stock (the Material Issue is cancelled); refused while it has an invoice. Amending it gives a new
draft without the labour, signature and ticks. Deleting a draft work order is refused once it has
appointments (cancel it instead); deleting one made from a request reopens the request.

### Invoicing

One draft Sales Invoice per work order, in the company currency, priced by the selling engine:

* each **part**: its item and quantity at the price list's rate (pricing rules apply); a part
  marked `warranty`, or every part when `parts_covered`, at a 100% discount;
* each **billable labour** line: the labour item, `hours` × the line's `bill_rate` (no bill rate:
  the labour item's own price), at a 100% discount when `labour_covered`;
* each **billable expense**: the expense item, quantity 1 at the amount.

Taxes follow the company's default sales template. Nothing billable → refused ("nothing to
invoice"). The work order's row is locked by the action, so concurrent requests make one invoice;
a second request is refused. Deleting the draft or cancelling the invoice releases the work order
(back to Completed) to be invoiced again.

## Service Appointment (`ServiceAppointment`, `FSA-YYYY-######`)

`work_order` (fixed once saved; an open work order), `scheduled_start`, `scheduled_end` (after the
start, at most 31 days), `technicians` (`technician`, unique, active when added), `notes`; set by
the app: `status` (Scheduled, Dispatched, En Route, On Site, Completed, Cannot Complete,
Cancelled), `travel_started_at`, `actual_start`, `actual_end`. Statuses change through the work
order's actions and `cancel_appointment`.

**No double booking.** Active appointments (Scheduled, Dispatched, En Route, On Site) reserve their
technicians' time: an exclusion constraint on the technician rows makes two overlapping
reservations of one technician impossible, whatever writes them. Bookings of a technician queue
on a lock first, so a refused booking names the appointment in the way (`Carol is already booked
Mon 2 Nov 09:00–11:00 on FSA-2026-000003`); back-to-back slots are fine. Completed, Cannot
Complete and Cancelled appointments free the time. A dispatched appointment that is moved returns
to Scheduled; one under way (En Route, On Site) cannot be moved. Only Scheduled or Cancelled
appointments can be deleted.

| Action | Who | Effect |
|---|---|---|
| `cancel_appointment` | dispatchers, managers (write access) | Scheduled, Dispatched or En Route → Cancelled; the time is freed, the work order follows (New without another active visit), dispatched technicians are told |

## Service Contract (`ServiceContract`, `FSC-YYYY-####`, submittable)

`company`, `customer`, `equipment` (the customer's; empty = all their equipment), `start_date`,
`end_date`, the maintenance plan — `frequency` (Days, Weeks, Months, Years), `repeat_every`,
`first_due_date` (default: the start), `lead_days` (create work orders this many days ahead, 7),
`work_type` (Maintenance), `priority`, `checklist_template`, `estimated_duration_minutes` — the
service level and coverage — `sla_response_hours`, `sla_resolution_hours`, `covers_parts`,
`covers_labour` — and `contract_value`, `terms`. Set by the app: `status` (Draft, Active,
Expired, Cancelled), `next_due_date`, `occurrences`.

Submitting activates it. Maintenance then creates one work order per planned visit once it is
within the lead time (`service_contract`, `contract_due_date`, the plan's type, priority, checklist
and duration; site from the equipment or the customer), up to 50 per contract per run when
catching up. Visit *k* is counted from the first visit (month ends do not drift: 31 Jan →
28 Feb → 31 Mar). After the last visit of the term nothing more is due; the contract still covers
work orders until it ends. Cancelling stops the plan (work orders already made stay).
**Exactly once:** the contract row is locked while a visit is planned and its next due date moves
in the same transaction; a unique index on (contract, due date) backs it up.

## Endpoints

Conventions: JSON (bodies ≤ 64 KB), `Cache-Control: no-store`, errors as in the platform API
(`{"error", "message", "fields"?}` with 422/404/403/401/429).

### `GET /api/app/field_service/dispatch` — the dispatch board

Signed in; needs read access to service work orders and appointments. Query: `from`, `to`
(`YYYY-MM-DD` in the workspace's zone; default today; at most 31 days), `territory` (id).

→ `{from, to, time_zone, travel_speed_kmh, technicians: [{technician, technician_name, user_email,
territory, territory_name, time_zone, home: {latitude, longitude} | null, working_hours: [{start,
end}] (UTC instants, in the technician's own zone — DST included), available_hours (null without
working hours), booked_hours, appointments: [{appointment, number, status, start, end,
actual_start, actual_end, work_order, work_order_number, customer_name, priority, site, travel:
{from: "home" | previous appointment number, km, minutes} | null}]}], unscheduled: [{work_order,
number, customer_name, priority, work_type, reported_at, response_due, resolution_due, sla_status,
response_breached, territory, territory_name, site, estimated_duration_minutes, preferred_start,
required_skills: [names]}]}`. Unscheduled = work orders in New, Urgent first, then by response
deadline, then report time. Technicians who only see their own appointments get only their own day.
Errors: 422 (`from`/`to`/`territory`), 403 (no read access), 404 for anonymous callers.

### `POST /api/site/{tenant}/field_service/requests` — a customer files a request

Public; only when `public_requests` is on (else 404). Body: `subject` (≤ 300), `contact_name`
(≤ 140), `contact_email` (required), `description` (≤ 5000), `contact_phone`, `site_address`,
`serial_no`, `preferred_start` (RFC 3339), `work_type`. The email identifies the customer when
exactly one customer has it; the serial number then links that customer's equipment (otherwise it
is noted in the description). At most 10 public requests per address and 5 per email per hour
(429). The contact gets a confirmation with the tracking link (Mail app).

→ `201 {reference, status, tracking_path, tracking_url, expires_at}`. Errors: 422 (fields), 429, 404.

### `GET /api/site/{tenant}/field_service/track/{token}` — follow a request

Public, authenticated by the token: `{request}.{expiry}.{128-bit HMAC-SHA256}` signed with a
per-tenant key kept outside every entity (table `field_service_secret`), compared in constant
time, expiring. Unknown, tampered and expired tokens all answer 404.

→ `{reference, subject, status, requested_at, rejection_reason, visit: {status, scheduled_start,
scheduled_end, technicians: [first names], on_the_way_since, arrived_at, completed_at} | null}`;
with `Accept: text/html` a small page (no scripts) instead. `Referrer-Policy: no-referrer`.

## Maintenance (every minute)

Per active tenant with the package: plan due contract visits (above); expire active contracts
whose end date has passed; re-judge the SLA of open work orders past a quarter-left point of a
pending deadline, under their row lock — a new breach notifies the crew and the work order's
creator, and verdict changes are published as `ServiceWorkOrder.updated` for automations and
webhooks. Idempotent and safe to run concurrently.

## Reports

All carry the caller's record scopes; costs show only to roles with the `costing` group.

| Report | Params | Rows |
|---|---|---|
| `fs_work_order_summary` | from/to (reported), group by Status, Technician, Territory, Work Type, Priority, Customer | work orders, new, scheduled, en route/on site, completed, invoiced, cancelled, SLA breached |
| `fs_first_time_fix` | from/to (completed), group by | completed, fixed on the first visit, revisits, rate %, average visits |
| `fs_sla_compliance` | from/to (reported), group by | response met/breached/pending and %, resolution met/breached/pending and % |
| `fs_technician_utilization` | from/to, territory | available hours (working hours in each technician's zone), scheduled, worked, billable hours, utilization %, billable %, jobs completed; technicians see their own row |
| `fs_parts_consumption` | from/to (completed), company, warehouse | per item: quantity, under warranty or contract, billable, cost, work orders |
| `fs_contract_revenue` | company, customer | per contract: value, work orders, completed, invoiced work (submitted invoices before tax), revenue, labour and parts cost, margin |
