# Changelog

## 0.1.1

- Requires the ERP app (Ferrum docs/plan/apps-ui.md §13): installing it in a workspace without ERP
  installs ERP whole, with its interface, rather than a few of its packages.
- Declares where it keeps people's personal data, so Administration → Personal data exports and
  erases it for a person (by email).

## 0.1.0

- First release: field service on Ferrum's own customers, items, stock and books. Service requests
  from staff, the helpdesk and a rate-limited public endpoint become work orders whose status
  follows their appointments (New → Scheduled → Dispatched → En Route → On Site → Completed →
  Invoiced, or Cancelled); SLA deadlines come from the service contract or the priority and are
  re-judged by maintenance. Appointments reserve one or more technicians' time, with double
  booking made impossible by an exclusion constraint; an explainable ranking (skills, territory,
  working hours in the technician's time zone, haversine travel from home or the previous job,
  workload) and a dispatch board help plan. Completion checks required checklist items, the
  customer's signature and stock, issues the parts from the technician's van on a Material Issue
  and freezes the job, which is then invoiced exactly once as a draft Sales Invoice (parts at
  price-list rates, labour hours × bill rate, billable expenses, warranty and contract coverage at
  zero), automatically if configured. Service contracts carry SLAs, coverage and maintenance plans
  whose visits are created exactly once; customers follow requests with signed, expiring tracking
  links; six reports cover status, first-time fix, SLA compliance, utilization, parts and revenue
  per contract.
