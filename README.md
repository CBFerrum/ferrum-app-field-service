# Ferrum Field Service

A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first ERP.

- Service requests from staff, the helpdesk (ticket details copied when the Helpdesk app is installed) and customers (a public endpoint with rate limits), converted into work orders
- Work orders with site, equipment, type, priority, checklist from a template, parts, labour, expenses, notes, photos and the customer's signature; status New → Scheduled → Dispatched → En Route → On Site → Completed → Invoiced (or Cancelled)
- SLA response and resolution deadlines from the service contract or the priority, with breach flags kept current by maintenance
- Appointments for one or more technicians; double booking is impossible, even under concurrent requests (database exclusion constraint)
- Explainable technician ranking (skills, territory, working hours in the technician's own time zone, travel from home or the previous job, workload) and a dispatch board endpoint
- Completion checks required checklist items, signature and stock; parts leave the technician's van on a Material Issue; the job is frozen and invoiced exactly once (parts at price-list rates, labour hours × bill rate, billable expenses, warranty and contract coverage at zero), automatically if you like
- Installed base with warranties, service contracts with maintenance plans that create each planned visit exactly once
- Signed, expiring tracking links for customers; emails through the Mail app when it is installed
- Reports: work orders by status or technician, first-time fix rate, SLA compliance, technician utilization, parts consumption, revenue per contract
- `packages/field_service/README.md` documents every entity, action, endpoint, setting and maintenance job

## Install

Workspace administrators install it from **Apps** in Ferrum; it ships in the official Ferrum
server image. Self-hosters building their own image enable the `field-service` feature of the server.
Everything it adds is also available to AI agents over Ferrum's MCP server.

## Develop

Clone it next to the platform and point the platform dependencies at your checkout (this file
is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-calc = { path = "../ferrum/crates/calc" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role — row-level security must apply:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_field_service_test
```

```bash
cargo test
```

`FERRUM_FIELD_SERVICE_TEST_DATABASE_URL` overrides the database URL. The app's metadata lives in `packages/` and is embedded
at build time; `app.yaml` is its manifest (see Ferrum's `docs/plan/apps.md`).

## License

AGPL-3.0-only, like the platform.
