// Field Service's requests: the dispatch board, and the actions on work orders and appointments.
// The server holds the rules (who is free, what may move, what may be completed); these only ask
// and pass its answers on.

import { api, ApiError, docPath, errorMessage } from "@ferrum/client";
import type { Board } from "./board";
import { sentence } from "./reason";

export const BOARD = "/api/app/field_service/dispatch";

/** The message of a failed request, from its field refusals when there are any (a clash names the
 *  appointment in the way). */
export function reason(e: unknown): string {
  return (e instanceof ApiError && sentence(e.fields)) || errorMessage(e, false);
}

export const loadBoard = (q: { from: string; to: string; territory?: string | null }, signal?: AbortSignal) =>
  api.get<Board>(BOARD, { from: q.from, to: q.to, territory: q.territory ?? undefined }, signal);

/** One technician as the server ranks them for a slot. */
export interface Suggestion {
  technician: string;
  technician_name: string;
  eligible: boolean;
  score: number;
  distance_km: string | null;
  travel_minutes: number | null;
  travel_from: string | null;
  territory: string | null;
  territory_name: string | null;
  within_working_hours: boolean;
  jobs_that_day: number;
  reasons: string[];
}

export interface Suggestions {
  work_order: string;
  start: string;
  end: string;
  technicians: Suggestion[];
}

const iso = (t: number) => new Date(t).toISOString();

export const act = <T = unknown>(entity: string, id: string, action: string, body: unknown = {}) => api.post<T>(docPath(entity, id, "actions", action), body);

export const suggest = (workOrder: string, start: number, end: number, signal?: AbortSignal) =>
  api.post<Suggestions>(docPath("ServiceWorkOrder", workOrder, "actions", "suggest_technicians"), { start: iso(start), end: iso(end) }, { signal });

/** Plans a waiting job: a new appointment for these technicians. */
export const scheduleJob = (workOrder: string, technicians: string[], start: number, end: number) =>
  act("ServiceWorkOrder", workOrder, "schedule", { technicians, start: iso(start), end: iso(end) });

export const dispatchJob = (workOrder: string) => act("ServiceWorkOrder", workOrder, "dispatch");

export const cancelVisit = (appointment: string) => act("ServiceAppointment", appointment, "cancel_appointment");

interface CrewRow {
  id?: string;
  technician: string;
}

interface AppointmentDoc {
  version: number;
  technicians?: { id: string; technician: string }[];
}

/** Moves an appointment in time and, when asked, from one technician to another or adds one: the
 *  appointment as it stands is read first, so the change goes against its version and the crew's
 *  other members (who may be in lanes the board is not showing) stay. */
export async function moveVisit(appointment: string, to: { start: number; end: number; swap?: { from: string; to: string; add?: boolean } }) {
  const doc = await api.get<AppointmentDoc>(docPath("ServiceAppointment", appointment));
  let crew: CrewRow[] = (doc.technicians ?? []).map((r) => ({ id: r.id, technician: r.technician }));
  const s = to.swap;
  if (s && s.from !== s.to) {
    if (crew.some((r) => r.technician === s.to)) crew = s.add ? crew : crew.filter((r) => r.technician !== s.from);
    else crew = s.add ? [...crew, { technician: s.to }] : crew.map((r) => (r.technician === s.from ? { technician: s.to } : r));
  }
  return api.patch(docPath("ServiceAppointment", appointment), { scheduled_start: iso(to.start), scheduled_end: iso(to.end), technicians: crew }, { ifMatch: doc.version });
}
