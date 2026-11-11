// The dispatch board: a day across the technicians' lanes, the jobs still waiting beside them, and
// the job chosen in a drawer. A waiting job is dragged onto a lane and a visit to another time or
// lane; while one is held, the server ranks the technicians for the slot under it and says why. A
// move shows at once and goes back, with the server's reason on the lane, if it is refused. The
// keyboard and the drawer do everything the pointer does.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, todayIso, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Icon, StatePanel, TableSkeleton, toast, useDebounced, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { useMe } from "@ferrum/records";
import { cancelVisit, dispatchJob, loadBoard, moveVisit, reason, scheduleJob, type Suggestion, suggest } from "./api";
import {
  type Board,
  axisFor,
  candidateSlots,
  isMovable,
  type Job,
  neighbour,
  queueFilter,
  skillsAsked,
  undispatched,
  type Visit,
  withJobScheduled,
  withVisitMoved,
  withVisitStatus,
  workday,
} from "./board";
import { Drawer, type DrawerOps } from "./Drawer";
import { Grid, type Held, type Hover, type LaneOps, type Slot } from "./Lanes";
import { Queue, QueueCard } from "./Queue";
import { Failure, Stale } from "./Stale";
import { Week } from "./Week";
import { plans } from "./roles";
import { Tabs } from "./Tabs";
import { addDays, clock, dayLabel, isDay, weekStart } from "./time";
import "./board.css";

const ZOOMS = [40, 64, 96, 128];
const ZOOM_KEY = "fs.zoom";

function storedZoom(): number {
  try {
    const n = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(n) ? n : 64;
  } catch {
    return 64;
  }
}

/** What a technician's score and reasons for the slot under a held job say, near the pointer. */
function DropTip({ board, hover, held, verdict, waiting, tip }: { board: Board; hover: Hover; held: Held; verdict?: Suggestion; waiting: boolean; tip: RefObject<HTMLDivElement | null> }) {
  const lane = board.technicians.find((l) => l.technician === hover.lane);
  return (
    <div className="fs-tip" ref={tip} role="status">
      <strong>
        {hover.add ? tr("Add ") : ""}
        {lane?.technician_name ?? tr("Technician")} · {isolate(clock(hover.start, board.time_zone))}–{isolate(clock(hover.end, board.time_zone))}
      </strong>
      {verdict ? (
        <>
          <div className="fs-tip-score">
            <Badge tone={!verdict.eligible ? "red" : verdict.score >= 70 ? "green" : verdict.score >= 40 ? "amber" : "neutral"}>{verdict.eligible ? tr("Score {score}", { score: verdict.score }) : tr("Cannot take it")}</Badge>
          </div>
          <ul>
            {verdict.reasons.map((r) => (
              <li key={r}>{isolate(r)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="faint">{waiting ? tr("Checking…") : tr("Hold still to see how well they fit.")}</p>
      )}
      {held.kind === "visit" && !hover.add && <p className="faint">{tr("Hold Alt to add the technician instead of moving.")}</p>}
    </div>
  );
}

export function Dispatch() {
  useShellTitle(tr("Dispatch"));
  const qc = useQueryClient();
  const me = useMe().data;
  const [sp, setSp] = useSearchParams();
  const canPlan = plans(me?.user);
  const day = isDay(sp.get("day")) ? sp.get("day")! : todayIso();
  const week = sp.get("view") === "week";
  const first = week ? weekStart(day) : day;
  const last = week ? addDays(first, 6) : day;
  const territory = sp.get("territory") ?? "";
  const skill = sp.get("skill") ?? "";
  const selected = sp.get("job");
  const [search, setSearch] = useState("");
  const [perHour, setPerHour] = useState(storedZoom);
  const [rail, setRail] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [held, setHeld] = useState<Held | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [tabId, setTabId] = useState<string | null>(null);
  const [cardTab, setCardTab] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const timers = useRef<Record<string, number>>({});
  const refreshTimer = useRef<number | undefined>(undefined);

  const key = useMemo(() => ["fs", "board", first, last, territory], [first, last, territory]);
  const q = useQuery({ queryKey: key, enabled: !!me, queryFn: ({ signal }) => loadBoard({ from: first, to: last, territory }, signal) });
  const territories = useQuery({
    queryKey: ["fs", "territories"],
    queryFn: () => api.get<{ rows: { id: string; territory_name: string }[] }>("/api/v1/ServiceTerritory", { fields: "territory_name", sort: "territory_name asc", limit: 200 }).then((r) => r.rows),
    staleTime: 5 * 60_000,
  });
  const board = q.data;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => () => Object.values(timers.current).forEach((t) => window.clearTimeout(t)), []);

  // Other people's changes arrive as events; a burst of them is one refresh.
  const refresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["fs", "board"] }), 400);
  }, [qc]);
  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);
  useLiveEntity("ServiceAppointment", refresh);
  useLiveEntity("ServiceWorkOrder", refresh);

  const axis = useMemo(() => (board ? axisFor(day, board.time_zone, board.technicians) : null), [board, day]);
  const zone = board?.time_zone ?? me?.timezone ?? "UTC";
  const jobs = useMemo(() => (board ? queueFilter(board.unscheduled, { skill, q: search }) : []), [board, skill, search]);
  const skills = useMemo(() => (board ? skillsAsked(board.unscheduled) : []), [board]);
  const toSend = useMemo(() => (board ? undispatched(board) : []), [board]);
  const laneName = (id: string) => board?.technicians.find((l) => l.technician === id)?.technician_name ?? tr("the technician");
  // The block the arrow keys start from: the one last used, if it is still on the board.
  const roving = useMemo(() => {
    const all = board?.technicians.flatMap((l) => l.appointments) ?? [];
    return all.find((v) => v.appointment === tabId)?.appointment ?? all.find((v) => !v.appointment.startsWith("pending-"))?.appointment ?? null;
  }, [board, tabId]);
  const cardRoving = jobs.some((j) => j.work_order === cardTab) ? cardTab : (jobs[0]?.work_order ?? null);

  const set = (changes: Record<string, string | null>) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  const select = (workOrder: string | null) => {
    setMoving(false);
    set({ job: workOrder });
  };
  // From the keyboard, opening a job takes focus into its drawer, and closing it gives focus back.
  const opener = useRef<HTMLElement | null>(null);
  const openFrom = (el: HTMLElement, workOrder: string) => {
    opener.current = el;
    select(workOrder);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".fs-drawer")?.focus());
  };
  const close = () => {
    select(null);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) requestAnimationFrame(() => back.focus());
  };

  // ── asking the server, showing the answer at once, and putting it back if refused ──

  const say = (lane: string, message: string | null) => {
    window.clearTimeout(timers.current[lane]);
    setNotices((n) => {
      const next = { ...n };
      if (message) next[lane] = message;
      else delete next[lane];
      return next;
    });
    if (message) timers.current[lane] = window.setTimeout(() => say(lane, null), 12_000);
  };
  const settle = () => {
    void qc.invalidateQueries({ queryKey: ["fs", "board"] });
    void qc.invalidateQueries({ queryKey: ["fs", "wo"] });
    void qc.invalidateQueries({ queryKey: ["fs", "suggest"] });
  };
  const attempt = async (lane: string | null, change: (b: Board) => Board, request: () => Promise<unknown>, done?: string): Promise<string | null> => {
    const before = qc.getQueryData<Board>(key);
    qc.setQueryData<Board>(key, (b) => (b ? change(b) : b));
    if (lane) say(lane, null);
    try {
      await request();
      if (done) toast(done);
      return null;
    } catch (e) {
      qc.setQueryData(key, before);
      const said = reason(e);
      if (lane) say(lane, said);
      else toast(said, "error");
      return said;
    } finally {
      settle();
    }
  };
  const between = (s: Slot) => `${clock(s.start, zone)}–${clock(s.end, zone)}`;

  const assign: DrawerOps["assign"] = (job, lane, slot) =>
    attempt(lane, (b) => withJobScheduled(b, job.work_order, lane, slot.start, slot.end), () => scheduleJob(job.work_order, [lane], slot.start, slot.end), tr("{number} is with {lane}, {slot}. Dispatch it to tell them.", { number: job.number, lane: laneName(lane), slot: between(slot) }));
  const relocate: DrawerOps["relocate"] = (visit, from, to, slot, add) =>
    attempt(
      to,
      (b) => withVisitMoved(b, visit.appointment, { technician: to, from, start: slot.start, end: slot.end, add }),
      () => moveVisit(visit.appointment, { ...slot, swap: { from, to, add } }),
      `${visit.work_order_number} ${add ? tr("now includes {to}", { to: laneName(to) }) : tr("is with {to}", { to: laneName(to) })}, ${between(slot)}.${visit.status === "Dispatched" ? " It needs dispatching again." : ""}`,
    );
  const dispatch: DrawerOps["dispatch"] = (visit) =>
    attempt(null, (b) => withVisitStatus(b, visit.appointment, "Dispatched"), () => dispatchJob(visit.work_order), tr("{work_order_number} is dispatched.", { work_order_number: visit.work_order_number }));
  const cancel: DrawerOps["cancel"] = async (visit) => {
    const ok = await confirmDialog({
      title: tr("Cancel the visit for {value}?", { value: visit.customer_name || visit.work_order_number }),
      message: tr("The technician's time is freed and the job goes back to waiting. Technicians who had it are told."),
      confirmLabel: tr("Cancel visit"),
      cancelLabel: tr("Keep it"),
      danger: true,
    });
    if (!ok) return null;
    return attempt(null, (b) => withVisitStatus(b, visit.appointment, null), () => cancelVisit(visit.appointment), tr("The visit for {work_order_number} is cancelled.", { work_order_number: visit.work_order_number }));
  };
  const drawerOps: DrawerOps = { assign, relocate, dispatch, cancel };

  const dispatchAll = async () => {
    if (!toSend.length || sending) return;
    const n = toSend.length;
    const ok = await confirmDialog({
      title: (n === 1 ? tr("Dispatch {n} visit?", { n }) : tr("Dispatch {n} visits?", { n })),
      message: tr("Each technician is told. Customers with an email on file get their visit window."),
      confirmLabel: tr("Dispatch"),
    });
    if (!ok) return;
    setSending(true);
    let done = 0;
    const failed: string[] = [];
    for (const v of toSend) {
      try {
        await dispatchJob(v.work_order);
        done++;
        qc.setQueryData<Board>(key, (b) => (b ? withVisitStatus(b, v.appointment, "Dispatched") : b));
      } catch (e) {
        failed.push(`${v.work_order_number}: ${reason(e)}`);
      }
    }
    setSending(false);
    settle();
    if (failed.length) toast((failed.length > 1 ? tr("Dispatched {done} of {n}. {value} ({value1} more were refused)", { done, n, value: failed[0], value1: failed.length - 1 }) : tr("Dispatched {done} of {n}. {value}", { done, n, value: failed[0] })), "error");
    else toast((done === 1 ? tr("Dispatched {done} visit.", { done }) : tr("Dispatched {done} visits.", { done })));
  };

  // ── the pointer ──

  const probeKey = held && hover ? `${held.workOrder}|${hover.start}|${hover.end}` : "";
  const settled = useDebounced(probeKey, 160);
  const probe = useQuery({
    queryKey: ["fs", "suggest", "hover", settled],
    enabled: !!settled && settled === probeKey,
    staleTime: 60_000,
    queryFn: ({ signal }) => {
      const [wo, a, z] = settled.split("|");
      return suggest(wo, Number(a), Number(z), signal);
    },
  });
  const verdict = hover && settled === probeKey ? probe.data?.technicians.find((t) => t.technician === hover.lane) : undefined;

  const place = (h: Hover | null, x?: number, y?: number) => {
    if (x != null && y != null) {
      pointer.current = { x, y };
      if (tip.current) tip.current.style.transform = `translate(${x + 14}px, ${y + 18}px)`;
    }
    setHover((prev) => (prev && h && prev.lane === h.lane && prev.start === h.start && prev.end === h.end && prev.add === h.add) || (!prev && !h) ? prev : h);
  };
  // The tip appears after the first move over a lane: put it where the pointer is.
  useLayoutEffect(() => {
    if (tip.current) tip.current.style.transform = `translate(${pointer.current.x + 14}px, ${pointer.current.y + 18}px)`;
  }, [hover?.lane]);
  const hold = (h: Held | null) => {
    setHeld(h);
    if (!h) setHover(null);
  };
  const drop = (lane: string, slot: Slot, add: boolean) => {
    const h = held;
    setHeld(null);
    setHover(null);
    if (!h || !board) return;
    if (h.kind === "job") {
      const job = board.unscheduled.find((j) => j.work_order === h.workOrder);
      if (job) void assign(job, lane, slot);
      return;
    }
    const visit = board.technicians.find((l) => l.technician === h.from)?.appointments.find((v) => v.appointment === h.appointment);
    if (!visit || !isMovable(visit) || (add && lane === h.from)) return;
    if (!add && lane === h.from && slot.start === Date.parse(visit.start) && slot.end === Date.parse(visit.end)) return;
    void relocate(visit, h.from, lane, slot, add);
  };

  // ── the keyboard ──

  const focusBlock = (id: string) => {
    setTabId(id);
    requestAnimationFrame(() => {
      const el = grid.current?.querySelector<HTMLElement>(`[data-appointment="${CSS.escape(id)}"]`);
      el?.focus();
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  const blockKey = (e: KeyboardEvent, v: Visit) => {
    if (e.target !== e.currentTarget || !board) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFrom(e.currentTarget as HTMLElement, v.work_order);
    } else if (e.key.startsWith("Arrow")) {
      const next = neighbour(board.technicians, v.appointment, e.key);
      if (next) {
        e.preventDefault();
        focusBlock(next);
      }
    } else if (canPlan && e.key.toLowerCase() === "d" && v.status === "Scheduled" && !v.appointment.startsWith("pending-")) {
      void dispatch(v);
    } else if (canPlan && e.key.toLowerCase() === "m" && isMovable(v)) {
      openFrom(e.currentTarget as HTMLElement, v.work_order);
      setMoving(true);
    }
  };

  /** S: the job goes to the best technician the server finds for the first time that works. */
  const quick = async (job: Job) => {
    if (!canPlan || !board || !axis || working.has(job.work_order)) return;
    const slots = candidateSlots(job, workday(board.technicians, axis), now);
    if (!slots.length) {
      toast(tr("There is no time left on {day} for {number}. Choose another day.", { day: dayLabel(day), number: job.number }), "error");
      return;
    }
    setWorking((w) => new Set(w).add(job.work_order));
    try {
      for (const slot of slots) {
        const best = (await suggest(job.work_order, slot.start, slot.end)).technicians.find((t) => t.eligible);
        if (best) {
          await assign(job, best.technician, slot);
          return;
        }
      }
      toast(tr("No technician can take {number} on {day}. Choose one from the list.", { number: job.number, day: dayLabel(day) }), "error");
      select(job.work_order);
    } catch (e) {
      toast(reason(e), "error");
    } finally {
      setWorking((w) => {
        const next = new Set(w);
        next.delete(job.work_order);
        return next;
      });
    }
  };
  const cardKey = (e: KeyboardEvent, job: Job) => {
    if (e.target !== e.currentTarget) return;
    const i = jobs.findIndex((j) => j.work_order === job.work_order);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFrom(e.currentTarget as HTMLElement, job.work_order);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = jobs[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        setCardTab(next.work_order);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-job="${CSS.escape(next.work_order)}"]`)?.focus());
      }
    } else if (e.key.toLowerCase() === "s") {
      void quick(job);
    }
  };

  const ops: LaneOps = {
    canPlan,
    hold,
    hover: place,
    drop,
    resize: (v, lane, slot) => void relocate(v, lane, lane, slot, false),
    select,
    key: (e, v) => blockKey(e, v),
    dismiss: (lane) => say(lane, null),
  };

  // ── what to show ──

  const zoomIndex = ZOOMS.indexOf(perHour);
  const zoom = (by: number) => {
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, zoomIndex + by))];
    setPerHour(next);
    try {
      localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      // A private window may refuse; the zoom then lasts until the page closes.
    }
  };
  const lanes = board?.technicians ?? [];
  const booked = lanes.reduce((n, l) => n + (Number(l.booked_hours) || 0), 0);
  const isToday = day === todayIso();
  const startHint = (job: Job) => {
    if (!board || !axis) return now;
    const work = workday(board.technicians, axis);
    return candidateSlots(job, work, now)[0]?.start ?? work.start;
  };
  const selectedJob = board?.unscheduled.find((j) => j.work_order === selected);

  const body = q.error && !board ? (
    <Failure error={q.error} onRetry={() => void q.refetch()} />
  ) : !board || !axis ? (
    <TableSkeleton columns={8} rows={4} />
  ) : (
    <div className="fs-board" data-drawer={selected ? "" : undefined} data-rail={rail ? "" : undefined}>
      {rail && (
        <Queue jobs={jobs} total={board.unscheduled.length} filtered={!!skill || !!search.trim()} skills={skills} skill={skill} search={search} onSkill={(s) => set({ skill: s || null })} onSearch={setSearch} onClear={() => { setSearch(""); set({ skill: null }); }}>
          {jobs.map((job) => (
            <QueueCard
              key={job.work_order}
              job={job}
              zone={zone}
              now={now}
              selected={selected === job.work_order}
              canPlan={canPlan}
              tab={cardRoving === job.work_order}
              busy={working.has(job.work_order)}
              onSelect={select}
              onHold={hold}
              onKey={cardKey}
            />
          ))}
        </Queue>
      )}
      <div className="fs-main" ref={grid}>
        {lanes.length && week ? (
          <Week board={board} first={first} today={todayIso()} onOpen={(d) => set({ view: null, day: d === todayIso() ? null : d })} />
        ) : lanes.length ? (
          <>
            <Grid lanes={lanes} axis={axis} perHour={perHour} now={now} held={held} hover={hover} selected={selected} notices={notices} tabId={roving} ops={ops} />
            <ul className="fs-legend" aria-label={tr("Key")}>
              <li data-status="scheduled">{tr("Planned: needs dispatch")}</li>
              <li data-status="dispatched">{tr("Dispatched")}</li>
              <li data-status="en-route">{tr("On the way")}</li>
              <li data-status="on-site">{tr("On site")}</li>
              <li data-status="completed">{tr("Done")}</li>
              <li>
                <i className="fs-legend-travel" />
                {tr("Drive")}
              </li>
              <li>
                <i className="fs-legend-late" />
                {tr("Drive does not fit")}
              </li>
            </ul>
            <details className="fs-keys">
              <summary>{tr("Keyboard and touch")}</summary>
              <p>
                {(canPlan ? tr("Arrow keys move between jobs, Enter opens one. On a waiting job, S schedules it to the best technician; on a block, M moves it and D dispatches it. Drag with a mouse; on a touch screen or without one, choose a job and use its drawer. Hold Alt while dropping a visit to add the technician instead of moving it.") : tr("Arrow keys move between jobs, Enter opens one. On a waiting job, S schedules it to the best technician; on a block, M moves it and D dispatches it. Drag with a mouse; on a touch screen or without one, choose a job and use its drawer."))}
              </p>
            </details>
          </>
        ) : (
          territory ? (
            <StatePanel kind="no-matches" title={tr("No technicians in this territory")} onClear={() => set({ territory: null })} clearLabel={tr("Show every territory")} />
          ) : (
            <StatePanel kind="empty" title={tr("No technicians yet")} action={<Link to="/e/Technician/new">{tr("Add the first technician")}</Link>} />
          )
        )}
      </div>
      {selected && (
        <Drawer
          key={selected}
          board={board}
          workOrder={selected}
          canPlan={canPlan}
          now={now}
          startHint={selectedJob ? startHint(selectedJob) : now}
          ops={drawerOps}
          moving={moving}
          onMoving={setMoving}
          onClose={close}
        />
      )}
    </div>
  );

  return (
    <div className="fs-page fs-dispatch">
      <header className="fs-head">
        <div>
          <h1 className="sr-only">{tr("Dispatch")}</h1>
          <Tabs />
          <p className="page-sub" aria-live="polite">
            {board ? [
                week ? tr("Week of {date}", { date: dayLabel(first, { day: "numeric", month: "long" }) }) : dayLabel(day, { weekday: "long", day: "numeric", month: "long" }),
                lanes.length === 1 ? tr("1 technician") : tr("{n} technicians", { n: lanes.length }),
                tr("{n} waiting", { n: board.unscheduled.length }),
                ...(booked ? [tr("{hours} h booked", { hours: Math.round(booked * 10) / 10 })] : []),
              ].join(" · ") : " "}
          </p>
        </div>
        <div className="fs-tools">
          <div className="segmented" role="group" aria-label={tr("Show")}>
            <button type="button" aria-pressed={!week} onClick={() => set({ view: null })}>
              {tr("Day")}
            </button>
            <button type="button" aria-pressed={week} onClick={() => set({ view: "week" })}>
              {tr("Week")}
            </button>
          </div>
          <div className="fs-daynav" role="group" aria-label={week ? tr("Week") : tr("Day")}>
            <button type="button" className="icon-btn" aria-label={week ? tr("Previous week") : tr("Previous day")} onClick={() => set({ day: addDays(day, week ? -7 : -1) })}>
              <Icon name="left" />
            </button>
            <button type="button" className="btn btn-default btn-md" onClick={() => set({ day: null })} aria-current={isToday ? "date" : undefined}>
              {tr("Today")}
            </button>
            <button type="button" className="icon-btn" aria-label={week ? tr("Next week") : tr("Next day")} onClick={() => set({ day: addDays(day, week ? 7 : 1) })}>
              <Icon name="chevronRight" />
            </button>
            <input className="input fs-date" type="date" aria-label={tr("Day")} value={day} onChange={(e) => isDay(e.target.value) && set({ day: e.target.value === todayIso() ? null : e.target.value })} />
          </div>
          {(territories.data?.length ?? 0) > 0 && (
            <select className="select fs-territory" aria-label={tr("Territory")} value={territory} onChange={(e) => set({ territory: e.target.value || null })}>
              <option value="">{tr("All territories")}</option>
              {territories.data!.map((t) => (
                <option key={t.id} value={t.id}>
                  {isolate(t.territory_name)}
                </option>
              ))}
            </select>
          )}
          {!week && (
          <div className="segmented" role="group" aria-label={tr("Zoom")}>
            <button type="button" aria-label={tr("Zoom out")} disabled={zoomIndex <= 0} onClick={() => zoom(-1)}>
              −
            </button>
            <button type="button" aria-label={tr("Zoom in")} disabled={zoomIndex >= ZOOMS.length - 1} onClick={() => zoom(1)}>
              +
            </button>
          </div>
          )}
          <button type="button" className="btn btn-default btn-md" aria-pressed={rail} onClick={() => setRail(!rail)}>
            {tr("Waiting jobs")}
          </button>
          {canPlan && toSend.length > 0 && (
            <Button variant="primary" loading={sending} onClick={() => void dispatchAll()} title={tr("Tell the technicians about every visit that is planned but not sent")}>
              {tr("Dispatch {length}", { length: toSend.length })}
            </Button>
          )}
        </div>
      </header>
      {q.error && board && <Stale error={q.error} onRetry={() => void q.refetch()} />}
      {me && !canPlan && <Alert tone="info">{tr("You can look at the board. Planning is for dispatchers and service managers.")}</Alert>}
      {body}
      {held && hover && board && <DropTip board={board} hover={hover} held={held} verdict={verdict} waiting={!!probeKey && (settled !== probeKey || probe.isFetching)} tip={tip} />}
    </div>
  );
}
