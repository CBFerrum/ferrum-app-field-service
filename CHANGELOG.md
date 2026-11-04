# Changelog

## 0.2.1

Rebuilt with Ferrum-Frontend 80ff179: a field's label names its control for assistive technology, and a record whose title is a link shows that record's title, not its id.

## 0.2.0

- Field Service has an interface of its own, at /field-service/. It opens on the dispatch board for
  dispatchers and service managers, and on My day for technicians.
- The dispatch board shows a day across the technicians' lanes, shaded outside each one's working
  hours in their own time zone, with the drive between jobs drawn and flagged when it does not fit.
  Waiting jobs sit beside the lanes with how long their service level has left. Drag a job onto a
  lane to schedule it; while you hold it, the server ranks the technicians for that time and the
  board says why. Drag a visit to move it, pull its edge to change its length, hold Alt to add a
  technician instead of moving it. A move shows at once and, if the server refuses it, goes back with
  the reason on the lane. The keyboard and the job's drawer do everything the pointer does, and one
  button dispatches every visit that is planned but not sent. A week view shows how full each
  technician's days are.
- My day is built for a phone: the jobs in order, each with its address, directions, a number to
  call, the drive to it and its service level, and the one next step on the job in hand. When the
  dispatcher moves a job, it says so. A job's page has large ticks for the checklist, parts with
  their serial numbers, a timer for time, expenses, photos made smaller before they are sent, the
  customer's signature, and a bar that offers only the next step: start travel, arrive, complete.
- A work order has a page for the office: where it is on its way, its service-level clocks, the
  customer, site and equipment with warranty and contract cover, its visits and what happened, what
  it cost against what it bills, the invoice with covered lines marked, earlier jobs on the same
  equipment, and a tracking link to copy.
- Personal data: a person's request now reaches technicians.

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
