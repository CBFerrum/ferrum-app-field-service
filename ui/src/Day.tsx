// A technician's day, built for a phone: the jobs in the order they happen, each with where it is,
// who to call, how long the drive is and how its service level stands, and the one step to take next
// on the job in hand. When the dispatcher moves a job meanwhile, the screen says so.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, todayIso } from "@ferrum/client";
import { Alert, Badge, Button, EmptyState, ErrorState, Icon, Spinner, toast, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { useMe } from "@ferrum/records";
import { act, loadBoard, reason } from "./api";
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
          {clock(Date.parse(v.start), zone)}
          <span className="faint"> – {clock(Date.parse(v.end), zone)}</span>
        </time>
        <Badge tone={tone(status)}>{status}</Badge>
        {(job?.priority === "Urgent" || job?.priority === "High") && <Badge tone={priorityTone(job.priority)}>{job.priority}</Badge>}
        {sla && (
          <Badge tone={sla.tone} title={sla.title}>
            {sla.text}
          </Badge>
        )}
      </header>
      <h2 className="fs-stop-title">
        <Link to={path}>{customer}</Link>
      </h2>
      <p className="fs-stop-sub">{[v.work_order_number, job?.work_type, `${span(length * MINUTE)} planned`].filter(Boolean).join(" · ")}</p>
      {job?.site_address && <p className="fs-stop-address">{job.site_address}</p>}
      {v.travel && v.travel.minutes > 0 && (
        <p className="fs-stop-travel">
          <Icon name="timeline" size={13} /> About {span(v.travel.minutes * MINUTE)} to get there ({v.travel.km} km from {v.travel.from === "home" ? "where you start" : "your last job"})
        </p>
      )}
      {job?.description && <p className="fs-stop-problem">{job.description}</p>}
      {(maps || tel) && (
        <div className="fs-stop-links">
          {maps && (
            <a className="btn btn-default" href={maps} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={15} /> Directions
            </a>
          )}
          {tel && (
            <a className="btn btn-default" href={tel}>
              <Icon name="user" size={15} /> Call{job?.contact_name ? ` ${job.contact_name.split(" ")[0]}` : ""}
            </a>
          )}
        </div>
      )}
      <footer className="fs-stop-foot">
        {current && step?.action === "complete" ? (
          <Link className="btn btn-primary" to={path}>
            Finish the job
          </Link>
        ) : current && step ? (
          <Button variant="primary" loading={busy} onClick={() => onGo(step.action as "start_travel" | "arrive")}>
            {step.label}
          </Button>
        ) : (
          current && note && <p className="muted">{note}</p>
        )}
        <Link className="btn btn-default" to={path}>
          Open the job
        </Link>
      </footer>
    </article>
  );
}

export function Day() {
  useShellTitle("My day");
  const qc = useQueryClient();
  const me = useMe().data;
  const email = me?.user.email;
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
      const board = await loadBoard({ from: day, to: day }, signal);
      const lane = laneOf(board, email);
      const ids = [...new Set((lane?.appointments ?? []).map((v) => v.work_order))];
      const rows = ids.length
        ? await api.get<{ rows: Details[] }>("/api/v1/ServiceWorkOrder", { filters: JSON.stringify([["id", "in", ids]]), fields: FIELDS, titles: true, limit: 100 }, signal).then((r) => r.rows)
        : [];
      return { board, lane, details: new Map(rows.map((r) => [r.id, r])) };
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

  const go = async (stop: Stop, action: "start_travel" | "arrive") => {
    setActing(stop.visit.work_order);
    try {
      await act("ServiceWorkOrder", stop.visit.work_order, action);
      toast(action === "start_travel" ? "On your way. The customer is told if they asked to be." : "You are on site.");
    } catch (e) {
      toast(reason(e), "error");
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
    <Spinner label="Loading your day" />
  ) : !q.data.lane ? (
    <EmptyState title="You are not set up as a technician" icon="user">
      <p className="muted">A service manager adds a technician with your email address, and your jobs appear here.</p>
    </EmptyState>
  ) : !arranged || !count ? (
    <EmptyState title={isToday ? "Nothing planned for today" : `Nothing planned for ${dayLabel(day)}`} icon="check">
      <button type="button" className="link-btn" onClick={() => move(1)}>
        See {dayLabel(addDays(day, 1))}
      </button>
    </EmptyState>
  ) : (
    <>
      {arranged.now && <section aria-label="In hand">{card(arranged.now, true)}</section>}
      {arranged.next && (
        <section aria-label="Next up">
          <h2 className="fs-group">Next up</h2>
          {card(arranged.next, true)}
        </section>
      )}
      {arranged.later.length > 0 && (
        <section aria-label="Later">
          <h2 className="fs-group">Later</h2>
          <div className="fs-stops">{arranged.later.map((s) => card(s, false))}</div>
        </section>
      )}
      {arranged.done.length > 0 && (
        <section aria-label="Done">
          <h2 className="fs-group">Done</h2>
          <div className="fs-stops">{arranged.done.map((s) => card(s, false))}</div>
        </section>
      )}
    </>
  );

  return (
    <div className="fs-page fs-day">
      <header className="fs-head">
        <div>
          <h1 className="sr-only">My day</h1>
          <Tabs />
          <p className="page-sub" aria-live="polite">
            {q.data?.lane && arranged && count
              ? `${dayLabel(day, { weekday: "long", day: "numeric", month: "long" })} · ${todo} ${todo === 1 ? "job" : "jobs"} to do${first ? `, from ${clock(Date.parse(first.visit.start), zone)}` : ""}`
              : dayLabel(day, { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <div className="fs-daynav" role="group" aria-label="Day">
          <button type="button" className="icon-btn" aria-label="Previous day" onClick={() => move(-1)}>
            <Icon name="left" />
          </button>
          <button type="button" className="btn btn-default btn-md" onClick={() => setSp({}, { replace: true })} aria-current={isToday ? "date" : undefined}>
            Today
          </button>
          <button type="button" className="icon-btn" aria-label="Next day" onClick={() => move(1)}>
            <Icon name="chevronRight" />
          </button>
        </div>
      </header>
      {q.error && q.data && <Stale error={q.error} onRetry={() => void q.refetch()} />}
      {news.length > 0 && (
        <Alert tone="warning" action={<Button size="sm" onClick={() => setNews([])}>Got it</Button>}>
          <strong>Your dispatcher changed your day.</strong>
          <ul>
            {news.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Alert>
      )}
      {body}
    </div>
  );
}
