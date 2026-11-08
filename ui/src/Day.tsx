// A technician's day, built for a phone: the jobs in the order they happen, each with where it is,
// who to call, how long the drive is and how its service level stands, and the one step to take next
// on the job in hand. When the dispatcher moves a job meanwhile, the screen says so.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, bootstrap, todayIso, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, EmptyState, ErrorState, Icon, Spinner, toast, useLiveEntity, useShellTitle, placed } from "@ferrum/kit";
import { useMe } from "@ferrum/records";
import { act, loadBoard, reason } from "./api";
import type { Board, Lane } from "./board";
import { flush } from "./held";
import { hold, keepDay, keptDay, unreachable, waiting as heldSteps, type Waiting } from "./offline";
import { arrange, changes, type Details, directionsUrl, laneOf, nextStep, type Seen, seen, type Stop, telUrl, waiting } from "./journey";
import { slaChip } from "./sla";
import { Stale } from "./Stale";
import { priorityTone, tone } from "./status";
import { Tabs } from "./Tabs";
import { addDays, clock, dayLabel, isDay, span, MINUTE } from "./time";
import "./work.css";

const FIELDS =
  "customer_name,site_address,contact_name,contact_phone,priority,work_type,description,status,sla_status,response_due,resolution_due,response_breached,resolution_breached,arrived_at,completed_at,latitude,longitude,serial_no,equipment";

export function StopCard({ stop, zone, now, current, busy, onGo }: { stop: Stop; zone: string; now: number; current: boolean; busy: boolean; onGo: (action: "start_travel" | "arrive") => void }) {
  const { visit: v, job } = stop;
  // The work order's status leads: its actions are what a technician takes.
  const status = job?.status ?? v.status;
  const step = nextStep(status);
  const sla = slaChip({ ...job }, now, zone);
  const maps = directionsUrl(job);
  const tel = telUrl(job?.contact_phone);
  const customer = job?.customer_name || v.customer_name || v.work_order_number;
  const path = `/w/${v.work_order}`;
  const note = waiting(status);
  const length = Math.round((Date.parse(v.end) - Date.parse(v.start)) / MINUTE);
  return (
    <article className="fs-stop" data-current={current || undefined} data-done={["Completed", "Invoiced"].includes(status) || undefined}>
      <header className="fs-stop-head">
        <time className="fs-stop-time">
          {isolate(clock(Date.parse(v.start), zone))}
          <span className="faint"> – {isolate(clock(Date.parse(v.end), zone))}</span>
        </time>
        <Badge tone={tone(status)}>{isolate(status)}</Badge>
        {(job?.priority === "Urgent" || job?.priority === "High") && <Badge tone={priorityTone(job.priority)}>{isolate(job.priority)}</Badge>}
        {sla && (
          <Badge tone={sla.tone} title={sla.title}>
            {isolate(sla.text)}
          </Badge>
        )}
      </header>
      <h2 className="fs-stop-title">
        <Link to={path}>{isolate(customer)}</Link>
      </h2>
      <p className="fs-stop-sub">{isolate([v.work_order_number, job?.work_type, tr("{value} planned", { value: span(length * MINUTE) })].filter(Boolean).join(" · "))}</p>
      {job?.site_address && <p className="fs-stop-address">{isolate(job.site_address)}</p>}
      {v.travel && v.travel.minutes > 0 && (
        <p className="fs-stop-travel">
          <Icon name="timeline" size={13} /> {placed(tr("About {p1} to get there ({km} km from {p2}"), { p1: isolate(span(v.travel.minutes * MINUTE)), km: v.travel.km, p2: v.travel.from === "home" ? tr("where you start") : tr("your last job") })})
        </p>
      )}
      {job?.description && <p className="fs-stop-problem">{isolate(job.description)}</p>}
      {(maps || tel) && (
        <div className="fs-stop-links">
          {maps && (
            <a className="btn btn-default" href={maps} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={15} /> {tr("Directions")}
            </a>
          )}
          {tel && (
            <a className="btn btn-default" href={tel}>
              <Icon name="user" size={15} /> {tr("Call")}{job?.contact_name ? ` ${job.contact_name.split(" ")[0]}` : ""}
            </a>
          )}
        </div>
      )}
      <footer className="fs-stop-foot">
        {current && step?.action === "complete" ? (
          <Link className="btn btn-primary" to={path}>
            {tr("Finish the job")}
          </Link>
        ) : current && step ? (
          <Button variant="primary" loading={busy} onClick={() => onGo(step.action as "start_travel" | "arrive")}>
            {isolate(step.label)}
          </Button>
        ) : (
          current && note && <p className="muted">{isolate(note)}</p>
        )}
        <Link className="btn btn-default" to={path}>
          {tr("Open the job")}
        </Link>
      </footer>
    </article>
  );
}

/** A day as kept on the device: the board, the technician's lane and their jobs. */
interface DayData {
  board: Board;
  lane: Lane | undefined;
  details: [string, Details][];
}

export function Day() {
  useShellTitle(tr("My day"));
  const qc = useQueryClient();
  const me = useMe().data;
  // Offline, the person is the one this page was served to.
  const email = me?.user.email ?? bootstrap()?.person?.email;
  const [held, setHeld] = useState<Waiting[]>(() => heldSteps());
  const [sp, setSp] = useSearchParams();
  const day = isDay(sp.get("day")) ? sp.get("day")! : todayIso();
  const [now, setNow] = useState(() => Date.now());
  const [news, setNews] = useState<string[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const last = useRef<{ day: string; seen: Seen[] } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const q = useQuery({
    queryKey: ["fs", "day", day, email],
    enabled: !!email,
    queryFn: async ({ signal }) => {
      try {
        const board = await loadBoard({ from: day, to: day }, signal);
        const lane = laneOf(board, email);
        const ids = [...new Set((lane?.appointments ?? []).map((v) => v.work_order))];
        const rows = ids.length
          ? await api.get<{ rows: Details[] }>("/api/v1/ServiceWorkOrder", { filters: JSON.stringify([["id", "in", ids]]), fields: FIELDS, titles: true, limit: 100 }, signal).then((r) => r.rows)
          : [];
        const details: [string, Details][] = rows.map((r) => [r.id, r]);
        keepDay<DayData>(day, { board, lane, details });
        return { board, lane, details: new Map(details), offline: null as string | null };
      } catch (e) {
        // No connection: the day as this device last had it, while the lease lets it keep that.
        const kept = unreachable(e) ? keptDay<DayData>(day) : null;
        if (!kept) throw e;
        return { board: kept.data.board, lane: kept.data.lane, details: new Map(kept.data.details), offline: kept.at };
      }
    },
  });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // What the dispatcher changed since the last look, told in words and not just redrawn.
  useEffect(() => {
    if (!q.data?.lane) return;
    const after = seen(q.data.lane.appointments);
    if (last.current?.day === day) {
      const said = changes(last.current.seen, after, q.data.board.time_zone);
      if (said.length) setNews((n) => [...new Set([...n, ...said])]);
    } else setNews([]);
    last.current = { day, seen: after };
  }, [q.data, day]);

  const refresh = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["fs", "day"] }), 400);
  }, [qc]);
  useLiveEntity("ServiceAppointment", refresh);
  useLiveEntity("ServiceWorkOrder", refresh);

  const zone = q.data?.board.time_zone ?? me?.timezone ?? "UTC";
  const arranged = useMemo(() => (q.data?.lane ? arrange(q.data.lane.appointments, q.data.details) : null), [q.data]);
  const count = arranged ? (arranged.now ? 1 : 0) + (arranged.next ? 1 : 0) + arranged.later.length + arranged.done.length : 0;
  const todo = arranged ? count - arranged.done.length : 0;
  const first = arranged?.now ?? arranged?.next ?? arranged?.done[0];

  // What was taken offline goes when the server answers again, in the order it was taken.
  const online = !!q.data && !q.data.offline;
  useEffect(() => {
    const sendHeld = () => void flush(qc).then(() => setHeld(heldSteps()));
    if (online) sendHeld();
    window.addEventListener("online", sendHeld);
    return () => window.removeEventListener("online", sendHeld);
  }, [online, qc]);
  // A job's page opens without a connection only if its code came while there was one.
  useEffect(() => {
    if (online) void import("./Order").catch(() => undefined);
  }, [online]);

  const go = async (stop: Stop, action: "start_travel" | "arrive") => {
    const label = `${action === "start_travel" ? "On your way to" : "On site at"} ${stop.job?.customer_name || stop.visit.customer_name || stop.visit.work_order_number}`;
    const keep = () => hold({ work_order: stop.visit.work_order, action, at: new Date().toISOString(), label });
    setActing(stop.visit.work_order);
    try {
      // Behind steps already waiting, it waits too, so they all go in the order taken.
      if (heldSteps().length) {
        if (!keep()) throw new Error(tr("This phone cannot keep it."));
        setHeld(heldSteps());
        void flush(qc).then(() => setHeld(heldSteps()));
        return;
      }
      await act("ServiceWorkOrder", stop.visit.work_order, action);
      toast(action === "start_travel" ? tr("On your way. The customer is told if they asked to be.") : tr("You are on site."));
    } catch (e) {
      if (unreachable(e) && keep()) {
        setHeld(heldSteps());
        toast(tr("No connection: it is sent when the connection is back."));
      } else toast(reason(e), "error");
    } finally {
      setActing(null);
      void qc.invalidateQueries({ queryKey: ["fs"] });
    }
  };
  const move = (by: number) => setSp({ day: addDays(day, by) }, { replace: true });
  const isToday = day === todayIso();

  const card = (stop: Stop, current: boolean) => (
    <StopCard key={stop.visit.appointment} stop={stop} zone={zone} now={now} current={current} busy={acting === stop.visit.work_order} onGo={(a) => void go(stop, a)} />
  );

  const body = q.error && !q.data ? (
    <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  ) : !q.data ? (
    <Spinner label={tr("Loading your day")} />
  ) : !q.data.lane ? (
    <EmptyState title={tr("You are not set up as a technician")} icon="user">
      <p className="muted">{tr("A service manager adds a technician with your email address, and your jobs appear here.")}</p>
    </EmptyState>
  ) : !arranged || !count ? (
    <EmptyState title={isToday ? tr("Nothing planned for today") : tr("Nothing planned for {day}", { day: dayLabel(day) })} icon="check">
      <button type="button" className="link-btn" onClick={() => move(1)}>
        {tr("See")} {isolate(dayLabel(addDays(day, 1)))}
      </button>
    </EmptyState>
  ) : (
    <>
      {arranged.now && <section aria-label={tr("In hand")}>{card(arranged.now, true)}</section>}
      {arranged.next && (
        <section aria-label={tr("Next up")}>
          <h2 className="fs-group">{tr("Next up")}</h2>
          {card(arranged.next, true)}
        </section>
      )}
      {arranged.later.length > 0 && (
        <section aria-label={tr("Later")}>
          <h2 className="fs-group">{tr("Later")}</h2>
          <div className="fs-stops">{arranged.later.map((s) => card(s, false))}</div>
        </section>
      )}
      {arranged.done.length > 0 && (
        <section aria-label={tr("Done")}>
          <h2 className="fs-group">{tr("Done")}</h2>
          <div className="fs-stops">{arranged.done.map((s) => card(s, false))}</div>
        </section>
      )}
    </>
  );

  return (
    <div className="fs-page fs-day">
      <header className="fs-head">
        <div>
          <h1 className="sr-only">{tr("My day")}</h1>
          <Tabs />
          <p className="page-sub" aria-live="polite">
            {q.data?.lane && arranged && count
              ? ((d: string, from: string | null) =>
                  from
                    ? todo === 1 ? tr("{day} · 1 job to do, from {from}", { day: d, from }) : tr("{day} · {todo} jobs to do, from {from}", { day: d, todo, from })
                    : todo === 1 ? tr("{day} · 1 job to do", { day: d }) : tr("{day} · {todo} jobs to do", { day: d, todo }))(dayLabel(day, { weekday: "long", day: "numeric", month: "long" }), first ? clock(Date.parse(first.visit.start), zone) : null)
              : dayLabel(day, { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <div className="fs-daynav" role="group" aria-label={tr("Day")}>
          <button type="button" className="icon-btn" aria-label={tr("Previous day")} onClick={() => move(-1)}>
            <Icon name="left" />
          </button>
          <button type="button" className="btn btn-default btn-md" onClick={() => setSp({}, { replace: true })} aria-current={isToday ? "date" : undefined}>
            {tr("Today")}
          </button>
          <button type="button" className="icon-btn" aria-label={tr("Next day")} onClick={() => move(1)}>
            <Icon name="chevronRight" />
          </button>
        </div>
      </header>
      {q.error && q.data && <Stale error={q.error} onRetry={() => void q.refetch()} />}
      {q.data?.offline && (
        <Alert tone="info" action={<Button size="sm" icon="refresh" onClick={() => void q.refetch()}>{tr("Try again")}</Button>}>
          {placed(tr("No connection: your day as it was at {p1}. What you do is sent when the connection is back."), { p1: isolate(clock(Date.parse(q.data.offline), zone)) })}
        </Alert>
      )}
      {held.length > 0 && (
        <Alert tone="warning">
          <strong>{tr("Waiting to be sent")}</strong>
          <ul>
            {held.map((w) => (
              <li key={w.key}>
                {isolate(w.label)}, {isolate(clock(Date.parse(w.at), zone))}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {news.length > 0 && (
        <Alert tone="warning" action={<Button size="sm" onClick={() => setNews([])}>{tr("Got it")}</Button>}>
          <strong>{tr("Your dispatcher changed your day.")}</strong>
          <ul>
            {news.map((n) => (
              <li key={n}>{isolate(n)}</li>
            ))}
          </ul>
        </Alert>
      )}
      {body}
    </div>
  );
}
