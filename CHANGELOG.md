# Changelog

## 0.4.12

Rebuilt with Ferrum-Frontend 155518c: the sentences its pages built in code (counts, dates, what a toast or a screen reader says) go through t() too, as whole sentences where code chose a word, and carry built-in Arabic and Hindi (335 words each in ui/src/locales, translated by the model and to be reviewed by native speakers).

## 0.4.11

The assistant knows what its records mean in its pages (contributes.shell.assistant): their states, what counts and where figures come from, with questions it suggests asking there.

## 0.4.10

Rebuilt with Ferrum-Frontend 5b22e7b: its own words carry built-in Arabic and Hindi (294 words each, ui/src/locales, translated by the model and to be reviewed by native speakers), fetched for the page's language only. The labels it keeps in objects, its dialogs, its page titles and the words it keeps in variables go through t() as well, and the names and sizes it shows as they are keep their order right to left. Its pages are drawn once their words are in, and its entry carries only the parts of the kit it uses.

## 0.4.9

Rebuilt with Ferrum-Frontend 6537d65: an action's link, code or token shown once is kept in a dialog to copy, and on a page that reads right to left, English left untranslated keeps its own order. Its own words go through the kit's t() (270 places), so a workspace's own words for its language reach them, and Admin, Interface words lists them under it (dist/words.json).

## 0.4.8

Rebuilt with Ferrum-Frontend d5d98f2: a workspace's own words for its interface (Admin, Interface words) reach its pages as they load; an attachment field that holds a picture shows it; and a value another record already has is said so, where the form said the record had been changed by someone else. Its own screens' margins, paddings, borders, alignment and insets go by the line's start and end, so they mirror right to left as the kit's do; what it places by coordinates (boards, timelines, charts, handles) stays as it was.

## 0.4.7

Rebuilt with Ferrum-Frontend 63280d3: right to left, its pages mirror as they read (icons that point along the line, margins and alignment by the line's start and end, arrow keys along it), and the records pages' words are in Arabic and Hindi.

## 0.4.6

Rebuilt with Ferrum-Frontend a64416a: a new record's box whose default is 1 shows ticked, as it is saved.

## 0.4.5

Rebuilt with Ferrum-Frontend 922fcfb: an action's dialog says every refusal, the errors on what the action made (another record's rows) among them, and an action with parameters and a confirmation asks once.

## 0.4.4

Rebuilt with Ferrum-Frontend a76295e: its pages show times on a person's own clock when they chose one on their Account page, while today and due dates stay on the workspace's day.

## 0.4.3

Rebuilt with Ferrum-Frontend 24c3951: its pages show times on the workspace's clock, naming the zone when it is not the browser's, a draft numbered on submit is headed as a draft, and a record of an app that is not installed says so.

## 0.4.2

Rebuilt with Ferrum-Frontend bb60115: a record page reads an empty number or check as the server does, so an action whose condition needs one shows, and a workspace's settings open as their one record.

## 0.4.1

The record pages ask for what their actions read: a service request's Reject needs the reason the customer is told and never asked for it, so it could not work from the request's page; Create Work Order can take a company, Customer Tracking Link can email the link, and it now says the link and how long it works; Cancel Work Order keeps a reason. Schedule and Suggest Technicians need a time, which the work order's page and the dispatch board ask for: a record page no longer offers them as buttons. The suite's reports cover the work order it moves thirty hours back (it failed between midnight and 06:00 in London).

## 0.4.0

A job can be finished without a connection (Ferrum docs/offline.md). The job as last opened is kept on the phone under the workspace's offline lease, with what the page needs to know about the person and what the settings ask before a job is completed, and opens offline from the day or by its link, under Field Service's own worker. What the technician does there waits on the phone as work not sent yet, kept whatever the lease says, and goes in the order taken when the connection is back: setting off and arriving; the checklist, parts, time, expenses and notes; photos and the customer's signature, whose pictures wait in IndexedDB; and completing the job. A change goes as what it does (a task ticked, a row added or taken out, a field set) and is made again on the job as it stands then, against its version, so nobody else's change is undone. One the server refuses is dropped and the reason said, and the job is then not completed after it, so it stays open to be put right; the other steps still go. Setting off, arriving and completing carry when they were taken (`at` on the actions, within the step before it and now), so arrival and completion times, and the SLA verdict on them, are when they happened rather than when the phone sent them; the customer is not emailed "on the way now" for setting off sent long after. The page says when the job was kept and how many steps wait. Built with Ferrum-Frontend 01b8ff0.

## 0.3.1

Time added by hand is read on the workspace's clock, as the job shows it: a technician whose phone is set to another time zone no longer records hours shifted by the difference. Time that ends in the future is refused, by the page and by the server ("is still to come: record time once it is worked"), with five minutes' slack for a phone's clock a little ahead. Built with Ferrum-Frontend 01b8ff0.

## 0.3.0

A technician's day works without a connection (Ferrum docs/offline.md). The day as last loaded is kept on the phone for the person signed in, under the workspace's offline lease, and shown when the server cannot be reached, saying when it was loaded; it is forgotten when the lease ends, when someone else signs in, or when they are signed out everywhere. Setting off and arriving, taken offline, wait on the phone as work not sent yet and go in the order taken when the connection is back; one the server refuses (the job moved meanwhile) is dropped and the reason said. The day's page opens offline under Field Service's own worker, and the app may be installed on a phone. Finishing a job (its checklist, parts, signature and proof) still needs the connection.

## 0.2.4

Rebuilt with Ferrum-Frontend 00dea07: in a workflow state that names what may change, the other fields show read-only, and the fields the state needs show required.

## 0.2.3

Personal-data requests find service request, service work order, technician records by the person's phone number as well as their email, and list the technician records holding their name apart, for an administrator to judge (never erased for the name alone) (Ferrum's FERRUM-PRIVACY-002).

## 0.2.2

Rebuilt with Ferrum-Frontend daeadda: after an action runs, a record page shows what the action said it did rather than only that it is done.

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
