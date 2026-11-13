<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Ferrum Field Service: dispatch the day, work the job, invoice it once" src="docs/assets/banner-light.svg" width="100%">
</picture>

<br>

[![Version](https://img.shields.io/badge/version-0.5.2-a63e30?style=flat-square)](CHANGELOG.md)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Ferrum platform](https://img.shields.io/badge/runs%20on-Ferrum-2f5bea?style=flat-square)](https://github.com/CBFerrum/Ferrum)
![Rust](https://img.shields.io/badge/Rust-server-b7410e?style=flat-square&logo=rust)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-data-336791?style=flat-square&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React%20%2B%20TypeScript-interface-149eca?style=flat-square&logo=react&logoColor=white)
![Tests](https://img.shields.io/badge/tests-12%20Rust%20%2B%2013%20UI%20files-16a34a?style=flat-square)

### Dispatch the day, work the job, and invoice it exactly once.

Ferrum Field Service is for repair, installation and maintenance teams that send technicians to customers. Requests
become work orders with a site, equipment, a checklist and service deadlines. Dispatchers plan the day on a board,
technicians work the job on a phone, even without a signal, and completed work is checked, signed and invoiced
through ERP.

[💡 Why](#-why-field-service) · [📸 Screenshots](#-screenshots) · [✨ Features](#-features) · [📊 Compare](#-how-it-compares) · [📍 Roadmap](#-roadmap) · [🚀 Install](#-install) · [🔧 Develop](#-develop)

</div>

## 💡 Why Field Service

- 🧭 **Dispatch that explains itself.** Technicians are ranked by skills, territory, working hours, travel and
  workload, and each score lists its reasons. A booking that would double-book a technician is refused by the database.
- 📴 **Work without a signal.** The technician's day and job open offline. Every step waits on the phone and goes
  to the server once, in order, however often it is sent. A refused step is never lost.
- 🧾 **Invoiced once.** Parts, labour and billable expenses become one draft sales invoice in ERP, priced by the
  selling engine, with warranty and contract cover applied.
- 🔗 **One data set with ERP and Helpdesk.** Customers, items, serial-numbered equipment, stock vans and invoices
  are the same records the rest of the business uses. A helpdesk ticket can become a request.
- 🛡️ **Warranty and contract cover decided for you.** The work order knows whether the equipment is under warranty
  and which service contract covers the visit, and bills accordingly.
- 🏠 **Self-hosted and open source.** AGPL-3.0, on your own server and database. Technicians' costs and bill rates
  are readable only by roles you allow.
- 🧩 **Changeable without code.** Add fields, automations and reports in Studio. Every record is reachable by the REST
  and MCP APIs under each person's permissions.

## 🎯 At a glance

| | |
|---|---|
| **Version** | 0.5.2 (platform `>=0.3.2, <0.4`) |
| **Kind** | Own interface at `/field-service/` (dispatch board, technician's day, work order pages), plus generic records screens; installable on a phone |
| **What it adds** | 21 entities (10 main, 11 child tables), 3 roles, 6 reports, 1 menu module, 2 public endpoints |
| **Depends on** | Ferrum core and **ERP** (installing Field Service installs ERP) |
| **Works with** | ERP (customers, items, stock, invoices), Helpdesk (tickets into requests), Mail (customer emails) |
| **Languages** | English, Arabic (right to left), Hindi; a workspace can change any interface word |
| **Tests** | 12 Rust tests (one runs a whole field-service workflow) and 13 interface test files |
| **Licence** | AGPL-3.0-only |

## 📸 Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-dispatch-dark.webp">
  <img alt="Dispatch board" src="docs/assets/screens/field-service-dispatch-light.webp" width="100%">
</picture>

**🧭 Dispatch board**<br><sub>Drag waiting jobs onto a technician's lane and see the best technician for the slot, with reasons.</sub>

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-service-work-order-list-dark.webp"><img alt="Service work orders" src="docs/assets/screens/field-service-service-work-order-list-light.webp"></picture>
<p><b>🧰 Work orders</b><br><sub>Browse, search and filter work orders by status, priority, customer and SLA.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-service-work-order-detail-dark.webp"><img alt="Work order record" src="docs/assets/screens/field-service-service-work-order-detail-light.webp"></picture>
<p><b>🔎 Work order record</b><br><sub>Read one job: its visits, checklist, parts, time, expenses, signature and invoice.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-service-work-order-new-dark.webp"><img alt="New work order" src="docs/assets/screens/field-service-service-work-order-new-light.webp"></picture>
<p><b>➕ New work order</b><br><sub>Open a job for a customer's equipment with its type, priority and required skills.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-service-request-list-dark.webp"><img alt="Service requests" src="docs/assets/screens/field-service-service-request-list-light.webp"></picture>
<p><b>📨 Service requests</b><br><sub>Triage what customers, staff and the helpdesk ask for, then convert or reject it.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-technician-list-dark.webp"><img alt="Technicians" src="docs/assets/screens/field-service-technician-list-light.webp"></picture>
<p><b>👷 Technicians</b><br><sub>Keep each technician's skills, territory, hours and van.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-report-fs-work-order-summary-dark.webp"><img alt="Work orders by status report" src="docs/assets/screens/field-service-report-fs-work-order-summary-light.webp"></picture>
<p><b>📊 Work orders by status</b><br><sub>Run the work order summary for a period and read the counts, including SLA breaches.</sub></p>
</td>
</tr>
</table>

<table>
<tr>
<td align="center" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-dispatch-phone-dark.webp"><img alt="Dispatch on a phone" src="docs/assets/screens/field-service-dispatch-phone-light.webp" width="260"></picture>
<p><b>📱 Dispatch on a phone</b></p>
</td>
<td align="center" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/field-service-service-work-order-list-phone-dark.webp"><img alt="Work orders on a phone" src="docs/assets/screens/field-service-service-work-order-list-phone-light.webp" width="260"></picture>
<p><b>📱 Work orders on a phone</b></p>
</td>
</tr>
</table>

## ✨ Features

### 📨 Service requests

- **Service Request** (`FSR-2026-00001`). Subject, description, source (Staff, Phone, Email, Helpdesk, Customer
  Portal), when it was requested, customer, contact (name, email, phone), equipment, site (address, coordinates,
  territory), work type (Repair, Installation, Maintenance, Inspection), priority (Low, Medium, High, Urgent) and
  a preferred start.
- **Fills itself in.** The equipment fills the customer and site. A contact email that belongs to exactly one
  customer sets the customer. The customer fills the contact.
- **From the helpdesk.** With Helpdesk installed, a ticket id or number copies the ticket's customer, contact,
  subject, description, priority and, by serial number, equipment. Without it, the number is kept as a reference.
- **Make Work Order.** Converts the request into a work order with everything carried over; the request becomes
  Converted. Refused without a customer and refused twice.
- **Reject.** A dispatcher or manager rejects with a required reason, and whoever filed it is told.
- **Final states.** Open, Converted, Rejected. Converted and rejected requests are final.
- **Requested time counts.** The SLA counts from the requested time, which cannot be in the future and is fixed once saved.
- **Public request form.** When switched on, customers file a request without signing in. The email identifies the
  customer when exactly one has it, and the serial number links their equipment. At most 10 requests per address and
  5 per email per hour. The contact gets a confirmation with a tracking link.
- **Tracking link.** A signed, expiring link (30 days by default) shows the request, the visit window, who is
  coming by first name, when they are on the way and when they arrived. Unknown, tampered and expired links all answer 404.

### 🧰 Work orders

- **Service Work Order** (`FSWO-2026-00001`, submittable). Company, customer, contact, equipment (must be the
  customer's; fills item, serial number and, where empty, site and territory), type, priority, description,
  reported and preferred times, planned duration, required skills and a checklist template.
- **Status follows the visit.** New, Scheduled, Dispatched, En Route, On Site follow the current appointment.
  Completed and Invoiced are submitted states. Cancelled is final.
- **Checklist.** Tasks with required and done flags; who and when are recorded by the server. Required tasks must
  be done before completion when the setting is on.
- **Parts.** Item, quantity, warehouse (the user's van, then the lead technician's van, then the settings'
  warehouse), serial numbers one per line, batch number, warranty flag and cost after completion.
- **Labour.** Technician, from and to times, billable flag. Hours are whole started minutes rounded up to the billing
  step. Bill and cost rates are the technician's rates when the line was entered. Crew members record their own time.
- **Expenses.** Type, description, amount, billable flag.
- **Proof of work.** Work notes, photos, the customer's signature drawn on the phone and the signer's name.
- **Derived for you.** Crew, scheduled times, first arrival, completion, number of visits, first-time fix,
  SLA fields, the covering service contract, warranty and cover flags, totals for hours, costs and expenses.
- **Warranty and cover.** Under warranty when the equipment's warranty ends on or after the reported day. Parts are
  covered by warranty or by the contract, labour by a warranty that covers labour or by the contract.
- **Completing.** Requires On Site, the required checklist, the signature and signer name (both settings), and for
  stock parts a warehouse, matching serial numbers, batch numbers and enough stock. Row errors say what is wrong,
  for example "not enough stock in Van A: 2 available, 3 needed".
- **On completion.** Parts leave stock on a Material Issue valued by the stock engine, the on-site visit is
  Completed, other open visits are Cancelled, the equipment's last service date is set and, if the setting is on,
  the invoice is drafted. The work order is frozen.
- **Reversing a completion.** A Service Manager cancels a completed work order: parts return to stock. Refused while
  an invoice exists. Amending it gives a new draft without the labour, signature and ticks.
- **Cancel.** Open appointments are cancelled, their time freed, dispatched technicians told and the SLA clock stops.
- **Deleting.** A draft with appointments cannot be deleted (cancel it). Deleting one made from a request reopens the request.
- **Field groups.** Planning fields are written by managers and dispatchers and read by technicians. Costing
  fields (cost rates, part and labour cost) are for managers only.

### 🧭 Scheduling and dispatch

- **Service Appointment** (`FSA-2026-000001`). A visit of one or more technicians (up to 20) for a work order, at most 31 days long.
  Statuses: Scheduled, Dispatched, En Route, On Site, Completed, Cannot Complete, Cancelled.
- **No double booking.** Active visits reserve their technicians' time. A database exclusion constraint makes two
  overlapping reservations of one technician impossible, whatever writes them. A refused booking names the
  visit in the way. Back-to-back slots are fine.
- **Suggest Technicians.** For a slot, ranks technicians 0 to 100 and says why. Not eligible: missing required
  skills, or already booked. Points: same territory 30, within working hours 20, up to 40 for short travel, workload up
  to 10 less 3 for each other job that day, and minus 20 when the technician cannot reach the job in time after the previous one.
- **Travel estimates.** Straight-line distance at an average speed (40 km/h by default), starting from the previous
  job that day, else the technician's home.
- **Schedule.** Plans or moves a visit. A dispatched visit that is moved goes back to Scheduled. A visit under way
  that is rescheduled ends as Cannot Complete and a revisit is planned.
- **Dispatch.** Technicians get an in-app notification; the customer gets an email with the window and tracking link.
- **Start Travel and Arrive.** The customer is emailed that the technician is on the way. The first arrival meets or
  misses the response target.
- **Dispatch board.** A day across the technicians' lanes shaded outside their working hours in their own time zone,
  with the drive to each visit drawn before it, the waiting jobs beside it (urgent first), and a drawer for the chosen job.
- **Drag and drop.** Drag a waiting job onto a lane, a visit to another time or lane (Alt adds a technician), or pull an
  edge to change its length. A refused move goes back and shows the server's reason. The keyboard and drawer do everything the pointer does.
- **Week view.** Each technician's days by how full they are, to find the day with room.
- **Filters.** By territory, skill and view.

### 📱 The technician's day

- **My day.** The jobs in the order they happen, each with where it is, who to call, how long the drive is and how its service level stands.
- **Job sheet.** Checklist, parts, time, expenses, photos and sign-off, and one bar that always offers the next step: start travel, arrive, complete.
- **Installable.** The app can be installed on a phone from the browser.
- **Offline.** A technician's day and jobs are kept under the workspace's offline lease. Setting off, arriving,
  the checklist, parts, time, expenses, notes, photos, the signature and completing wait on the phone and go in order.
- **Done once.** Each step carries its key to the server, which keeps a receipt, so a lost answer, a reload or a second
  tab never does anything twice. Added rows carry a ref. A photo already on the job, by its digest, is not uploaded again.
- **Refused, waiting for you.** A step the server refuses is kept with its photo or signature. The technician tries
  it again, saves a copy or discards it (confirmed and noted on the job). The job is not completed meanwhile.
- **Real times.** Steps taken offline keep the time they were taken, and the SLA is judged by it.
- **Photos.** Made smaller on the phone before they are sent.
- **Moved jobs.** When a dispatcher moves a job, the day says so.
- **Technician's own work.** A technician sees only the work orders and appointments they are assigned to.

### ⏱️ Service levels

- **Targets by priority** in settings: response (to arrival on site) and resolution (to completion), in hours.
  Resolution is never shorter than response.
- **Contract targets** override the priority's when set.
- **Clock.** Starts at the reported time and runs in calendar hours. A planned visit starts at midnight of its due day.
- **Status.** On Track, At Risk (a quarter or less of the window left), Breached and Met. No target means no verdict.
- **Upkeep.** Every minute the verdicts are re-judged. A new breach notifies the crew and the work order's creator,
  and the change is published for automations and webhooks.
- **Stops on cancel.**

### 🛡️ Installed base and contracts

- **Customer Equipment.** Customer, item, serial number (unique per item), status, install date, warranty end, whether
  warranty covers labour, site address, coordinates and territory. Name and last service date are set by the app.
- **Service Contract** (`FSC-2026-0001`, submittable). Customer, one piece of equipment or all of theirs, term,
  maintenance plan (frequency in days, weeks, months or years, repeat every, first due date, lead days), work type,
  priority, checklist, planned duration, response and resolution targets, whether it covers parts and labour,
  value and terms. States: Draft, Active, Expired, Cancelled.
- **Planned visits made once.** Within the lead time (7 days by default), upkeep creates one work order per planned
  visit, up to 50 per run when catching up. Month ends do not drift (31 Jan, 28 Feb, 31 Mar). The contract row is locked and a
  unique index backs it up.
- **Expiry.** Active contracts whose end date passed expire. Cancelling stops the plan; work orders made stay.

### 🧾 Parts, stock and invoicing

- **Stock only through the stock engine.** Parts leave stock on a submitted Material Issue, from the technician's van or a warehouse.
- **One draft Sales Invoice per work order**, in the company currency, priced by the selling engine: parts at the price
  list's rate, billable labour at hours times the line's bill rate (else the labour item's price), billable expenses at their amount.
- **Cover.** Parts under warranty or covered by the contract, and covered labour, at a 100% discount.
- **Taxes** follow the company's default sales template.
- **Exactly once.** The action locks the work order's row, so concurrent requests make one invoice. Deleting the draft
  or cancelling the invoice releases the work order to be invoiced again.
- **Nothing billable** is refused with "nothing to invoice". With automatic invoicing, a work order that cannot
  be invoiced still completes and the person is told why.

### 📊 Reports

| Report | What it shows |
|---|---|
| **Work order summary** | Work orders by status, technician, territory, type, priority or customer: new, scheduled, on the way or on site, completed, invoiced, cancelled, SLA breached |
| **First-time fix** | Completed jobs, fixed on the first visit, revisits, rate and average visits |
| **SLA compliance** | Response and resolution met, breached or pending, with percentages |
| **Technician utilisation** | Available, scheduled, worked and billable hours per technician, utilisation, billable share, jobs completed |
| **Parts consumption** | Per item: quantity, under warranty or contract, billable, cost, work orders |
| **Contract revenue** | Per contract: value, work orders, completed, invoiced work, revenue, labour and parts cost, margin |

Reports carry each person's record scopes. Costs show only to roles with the costing field group.

### ⚙️ Settings

| Setting | What it does |
|---|---|
| Labour item, expense item | Service items invoiced for labour and billable expenses |
| Labour increment | Labour is billed in started steps of this many minutes (1) |
| Travel speed | Average speed for travel estimates (40 km/h) |
| Default duration | Job length when none is given (60 minutes) |
| Default warehouse | Where parts come from when the technician has no van |
| Require checklist, require signature | Both on by default |
| Auto invoice | Draft the invoice on completion (off) |
| Notify customer | Email the window, on-the-way notice, confirmations and tracking links (on) |
| Public requests | Accept requests on the public endpoint (off) |
| Tracking link days | How long tracking links last (30) |
| SLA targets | Response and resolution hours per priority |
| Default working hours | Weekday, start and end for technicians without their own; none means round the clock |

### 👷 Technicians, territories, skills and checklists

- **Technician.** The user they sign in with (what makes jobs theirs), active flag, phone, territory, skills with level,
  bill rate, hourly cost, time zone, working hours, home coordinates and van warehouse. Costs are in a restricted field group.
- **Service Territory** and **Service Skill.** What dispatch matches on.
- **Checklist Template.** Named tasks, each required or not, copied onto a work order.

### 🔔 Notifications and customer emails

- **In-app.** Technicians are told when a visit is dispatched or cancelled; the crew and the creator when an SLA is breached.
- **Email to customers** (with Mail): request confirmation, visit window, on the way, tracking link.

### 🔐 Roles, privacy and languages

- **Service Manager.** Runs settings, technicians and costs, contracts, requests, work orders and appointments, and invoices.
- **Dispatcher.** Takes requests, plans, schedules and dispatches, keeps the installed base. Cannot see costs.
- **Technician.** Works only their own jobs and visits, and files requests.
- **Personal data.** Requests for a person's data find service requests, work orders and technicians by email and phone.
- **Languages.** Arabic and Hindi words, record names and report names, with right-to-left layout.
- **Assistant.** The Ferrum assistant knows the work order states and suggests questions such as "Which work orders
  are on today, and who has them?"
- **APIs.** Every record and action is available over REST and MCP under the caller's permissions.

## 🧭 How it works

```mermaid
flowchart LR
    R["Request"] -->|"Make Work Order"| W["Work order: New"]
    W -->|"Schedule"| S["Scheduled"]
    S -->|"Dispatch"| D["Dispatched"]
    D -->|"Start Travel"| E["En Route"]
    E -->|"Arrive"| O["On Site"]
    O -->|"Complete: checklist, signature, stock"| C["Completed"]
    C -->|"Create Invoice, once"| I["Invoiced"]
    W -->|"Cancel"| X["Cancelled"]
```

The work order's status follows its current visit. Completing posts the parts out of stock and, when set, drafts the
invoice. The same job is two screens: the technician's, built for a phone, and the office's, with the whole state in one place.

```mermaid
flowchart TD
    FS["Field Service"] --> ERP["ERP: customers, items, stock, invoices"]
    HD["Helpdesk ticket"] -->|"becomes a request"| FS
    FS --> MAIL["Mail: visit and tracking emails"]
    FS --> SELL["Selling engine: prices and taxes"]
    FS --> STOCK["Stock engine: Material Issue"]
    CUST["Customer"] -->|"public form and tracking link"| FS
    FS --> BELL["In-app notifications, webhooks, automations"]
```

Field Service uses the platform's engines rather than its own: stock moves only on a Material Issue and invoices
are priced by the selling engine. Customers reach it through two public endpoints and a tracking link.

## 🧱 Data model

| Entity | What it is | Key fields or states |
|---|---|---|
| **Service Request** | A customer's or staff's ask | Subject, source, customer, equipment, work type, priority, status (Open, Converted, Rejected) |
| **Service Work Order** | A job | Customer, equipment, type, priority, status, crew, SLA state, totals, stock entry, sales invoice |
| **Service Appointment** | One visit | Work order, start, end, technicians, status (Scheduled to Cannot Complete) |
| **Service Contract** | A maintenance and service agreement | Customer, equipment, term, plan, targets, cover, status |
| **Customer Equipment** | The installed base | Customer, item, serial number, warranty end, site, last service |
| **Technician** | A person who works jobs | User, skills, territory, hours, time zone, rates, van |
| **Service Territory, Service Skill** | What dispatch matches on | Name |
| **Checklist Template** | A reusable checklist | Name, tasks |
| **Field Service Settings** | Workspace settings | See Settings above |
| Child tables | Skills, crew, checklist, parts, labour, expenses, appointment technicians, technician skills, SLA targets, working hours, template tasks | |

| Role | What it can do |
|---|---|
| **Service Manager** | Everything, plus settings, technicians and their costs, contracts, reversing a completion and invoicing |
| **Dispatcher** | Requests, work orders, appointments and the installed base; reads settings, technicians and contracts |
| **Technician** | Own work orders and appointments: travel, arrival, checklist, parts, time, expenses, signature, completion; files requests |

Reports: six, listed under Features. Print formats: none ship. Scheduled jobs: contract visits, contract expiry and SLA re-judging, every minute.

## 🔌 Integrations

| With | How | Needs |
|---|---|---|
| **ERP** | Customers, items, warehouses, stock entries, price lists, taxes and sales invoices | ERP installed (comes with Field Service) |
| **Helpdesk** | A ticket becomes a request, copying customer, contact, priority and equipment by serial number | Helpdesk installed (optional) |
| **Mail** | Confirmations, visit window, on-the-way and tracking emails | Mail app and its public URL (optional) |
| **Platform notifications and webhooks** | In-app bell, events for automations and webhooks | Platform |
| **MCP** | AI agents work with every record under each person's permissions | Platform's MCP server |
| **Offline** | Service worker and local queue on the phone | A modern browser |

Public endpoints: `POST /api/site/{tenant}/field_service/requests` (a request) and `GET .../track/{token}` (follow it).

## 📊 How it compares

Compared with Salesforce Field Service, ServiceTitan, Microsoft Dynamics 365 Field Service, Jobber and Odoo Field Service.

| Capability | Ferrum Field Service | Salesforce | ServiceTitan | Dynamics 365 | Jobber | Odoo |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Requests become work orders | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Public request form | ✅ | 🟡 | ✅ | 🟡 | ✅ | 🟡 |
| Customer tracking link | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Checklist, parts, labour, expenses, signature on a job | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Drag-and-drop dispatch board | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Technician ranking by skill, territory, hours and travel | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 |
| Auto-scheduling and route optimisation | ❌ | ✅ | ✅ | ✅ | 🟡 | ❌ |
| Map of jobs and technicians | ❌ | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Live technician location and ETA | ❌ | ✅ | ✅ | 🟡 | ✅ | ❌ |
| Works offline on a phone | ✅ | ✅ | 🟡 | ✅ | 🟡 | 🟡 |
| Native mobile app | ❌¹ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SLA targets with breach flags | 🟡² | ✅ | ❌ | ✅ | ❌ | ❌ |
| Service contracts with recurring maintenance visits | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 |
| Installed base with warranty | ✅ | ✅ | ✅ | ✅ | ❌ | 🟡 |
| Parts from van stock with serial and batch checks | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Quotes and estimates approved online | ❌ | 🟡 | ✅ | 🟡 | ✅ | ✅ |
| Price book, flat-rate tasks and memberships | 🟡³ | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Take payment on site | ❌ | 🟡 | ✅ | 🟡 | ✅ | 🟡 |
| Invoice from completed work | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Inspection forms with readings and conditional questions | 🟡⁴ | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Technician time off, shifts and blocked time | 🟡⁵ | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Follow-up and child work orders | ❌ | ✅ | 🟡 | ✅ | 🟡 | 🟡 |
| Vehicles and tools as bookable resources | ❌ | ✅ | 🟡 | ✅ | ❌ | 🟡 |
| Customer reminders and SMS | 🟡⁶ | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Customer portal | 🟡⁷ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Online booking from open slots | ❌ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| First-time fix, SLA and utilisation reports | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 |
| Helpdesk tickets raise visits on the same data | ✅ | ✅ | 🟡 | ✅ | ❌ | ✅ |
| Same data set as stock, accounting and customers | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| Self-hosted | ✅ | ❌ | ❌ | ❌ | ❌ | ✅⁸ |
| Open source | ✅ | ❌ | ❌ | ❌ | ❌ | 🟡⁸ |

¹ An installable web app that works offline, not an app-store app.
² Deadlines run in calendar hours, not in the contract's working hours; a quarter-left rule marks At Risk.
³ Prices come from ERP's price lists and pricing rules. There are no flat-rate tasks, trip or minimum charges.
⁴ Checklist tasks with required and done flags; no readings, pass or fail, photo-per-item or conditional questions.
⁵ Weekly working hours per technician in their own time zone; no leave, blocked time or non-job appointments.
⁶ Email for the visit window and on-the-way notice; no reminder before the visit, no SMS.
⁷ A signed tracking link per request; no portal with visits, quotes and invoices.
⁸ Odoo's Community edition is open source; Field Service is part of its Enterprise edition.

### 🏆 Where Field Service stands out

- 📴 **Offline work that is done once and loses nothing**, with refusals kept and explained.
- 🧭 **Explainable dispatch** with a database guarantee against double booking.
- 🧾 **Invoicing once**, through the same selling and stock engines as the rest of the business.
- 🛡️ **Warranty and contract cover decided from the equipment and the contract**, shown on the job.
- 🔗 **One data set** with ERP and Helpdesk, and Arabic and Hindi with right-to-left layout.
- 🏠 **Self-hosted and open source**, with MCP access for AI agents under each person's permissions.

### 🚧 Where the leaders are still ahead

- 🗺️ **Maps, road travel times and live location**, and automatic scheduling and route optimisation.
- 💳 **Quotes, price books and payment on site.**
- 📲 **Native apps, SMS, online booking and customer portals.**
- 📝 **Inspection forms** with readings, and technician time off.
- 🧩 **Depth**: job types, follow-up jobs, bookable vehicles and tools, years of vertical templates.

> [!NOTE]
> Leader columns are from public product information as of November 2026 and may change.

## 📍 Roadmap

### ✅ Recently shipped

- [x] **0.5.2.** Rebuilt on the tuned design system: better menu icons, lighter first page, cleaner print.
- [x] **0.5.1.** The redesigned interface with shaped loading and told-apart states.
- [x] **0.5.0.** Offline work done once and nothing refused lost: keys per step, refs per row, photo digests and a queue of refused steps.
- [x] **0.4.14 and 0.4.13.** Report names, record names and the last English sentences in Arabic and Hindi.
- [x] **0.4.0.** A job finished without a connection, each step with when it was taken.
- [x] **0.3.0.** A technician's day without a connection, kept under the workspace's offline lease.

### 🔜 Next up

- [ ] **Quotes and estimates**, with online approval by the customer.
- [ ] **Take payment on site** (card, pay link or deposit) through a payment provider.
- [ ] **Job types** with default duration, skills, checklist, priority and price.
- [ ] **Service levels in working hours** from the platform's calendars and targets.
- [ ] **Technician time off** and blocked time.
- [ ] **Reminders before the visit** and an SMS channel.
- [ ] **Map of jobs and technicians**, with road travel time.

### 🔭 Later

**Scheduling**
- [ ] Auto-scheduling and route optimisation for a whole day.
- [ ] Live technician location, arrival by geofence and an ETA on the tracking page.
- [ ] Online booking where the customer picks an open slot.
- [ ] Vehicles, tools and rooms as bookable resources.

**Jobs**
- [ ] Follow-up and child work orders for multi-step jobs.
- [ ] Statuses such as On Hold, Awaiting Parts and Needs Quote.
- [ ] Inspection forms with readings, pass or fail, required photos and conditional questions.
- [ ] Parts reserved and picked before the visit, and van replenishment from minimum and maximum levels.
- [ ] Travel time and clock-in recorded as labour for timesheets.

**Customers**
- [ ] Customer portal with visits, quotes, invoices and booking.
- [ ] Customer reschedules or cancels from the tracking link.
- [ ] Satisfaction or review request after the job.
- [ ] The job report or invoice sent from the phone as a printed form.

**Money and contracts**
- [ ] Price book with flat-rate tasks, trip charge, minimum charge and markup tiers.
- [ ] Contract renewals, recurring billing and seasonal plans.
- [ ] Job profitability and revenue per technician reports.

**Equipment and platform**
- [ ] Equipment hierarchy, meter readings and a history timeline.
- [ ] Push notification to the technician when a job is assigned or changed.
- [ ] A native phone app.

## 🚀 Install

Field Service is a native Ferrum app, compiled into the Ferrum server. Workspace administrators install it from
**Apps** (`/store/`). It needs platform `>=0.3.2, <0.4` and **ERP** `>=0.1`: installing Field Service in a workspace
without ERP installs ERP whole, with its interface. Self-hosters building their own image enable the `field-service`
feature of the server.

1. Install Field Service (and ERP with it).
2. Open Field Service Settings. Pick the labour and expense items, the targets per priority and the default working hours.
3. Create territories and skills, then technicians. A technician's user email is what makes jobs theirs, so it must exist.
4. Give people the roles: Service Manager, Dispatcher and Technician.
5. Add checklist templates and customer equipment.
6. Add service contracts and submit them to start their maintenance plans.
7. To take requests from customers, switch on Public requests and set Mail's public URL. To email customers, install Mail.
8. Technicians open `/field-service/`, and can install it on their phone.

## 🔧 Develop

Clone it next to the platform:

```text
work/
├── ferrum/                    https://github.com/CBFerrum/Ferrum
└── ferrum-app-field-service/
```

Point the platform dependencies at your checkout (this file is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-calc = { path = "../ferrum/crates/calc" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
```

The app also builds on [ferrum-app-erp](https://github.com/CBFerrum/ferrum-app-erp), which Cargo takes from GitHub.
To work on both, clone it into the same folder and add:

```toml
[patch."https://github.com/CBFerrum/ferrum-app-erp"]
ferrum-app-erp = { path = "../ferrum-app-erp" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role, so row-level security applies:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_field_service_test
export FERRUM_FIELD_SERVICE_TEST_DATABASE_URL=postgres://ferrum:ferrum@localhost:5432/ferrum_field_service_test
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The interface lives in `ui/` and builds with Ferrum-Frontend's packages, checked out next to this repository as
`../ferrum/web`:

```bash
cd ui
npm run build       # writes ui/dist, checked against the size budget
npm run check
npm run typecheck
npm test
```

With a development server started with `FERRUM_DEV_UI=true`, `ferrum-app dev --ui` serves the pages from Vite behind
the real bar and session, with hot reload.

## 📂 Project layout

```text
app.yaml          the manifest: id, version, requirements, what it adds to Ferrum
packages/field_service/
  entities/       service.yaml (requests, work orders, appointments, contracts), setup.yaml (settings, technicians, equipment)
  sql/            the exclusion constraint and unique indexes
  package.yaml    roles, field groups, menu, personal-data rules
src/              hooks, actions, endpoints and upkeep: work_order, appointment, dispatch, invoice,
                  contract, request, site (public endpoints), notify, reports, logic
ui/src/           the interface: dispatch board, week, technician's day, job sheet, offline queue, locales ar and hi
tests/            integration tests against a real PostgreSQL
CHANGELOG.md      what changed in each version
```

## 📜 Changelog

Every release is described in [CHANGELOG.md](CHANGELOG.md).

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/CBFerrum/ferrum-app-field-service/issues](https://github.com/CBFerrum/ferrum-app-field-service/issues).
Run the checks in [Develop](#-develop) first.

## 📄 License

AGPL-3.0-only. See [LICENSE](LICENSE).

<div align="center">

<sub>Part of <a href="https://github.com/CBFerrum/Ferrum">Ferrum</a>, the open business platform · Made with 🦀 Rust and 🐘 PostgreSQL</sub>

</div>
