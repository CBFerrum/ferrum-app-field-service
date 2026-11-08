// A day across the lanes: one lane per technician, shaded outside their working hours in their own
// zone, each visit a block on the day's axis with the drive to it drawn as a thin bar before it.
// A block is dragged to another time or lane (Alt adds the technician instead of moving), pulled
// by an edge to change its length, or chosen and moved from the drawer; the keyboard walks the
// blocks with the arrow keys.

import { type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { initials, t as tr, isolate } from "@ferrum/client";
import { Icon } from "@ferrum/kit";
import { type Axis, type Lane, type Placed, type Visit, at, isMovable, load, offHours, place, resized, slotAt } from "./board";
import { clock, hourLabel, MINUTE, span } from "./time";

/** What the pointer is holding: a waiting job, or a visit already on the board. */
export type Held =
  | { kind: "job"; workOrder: string; minutes: number; label: string }
  | { kind: "visit"; appointment: string; workOrder: string; from: string; minutes: number; grab: number; label: string };

/** The slot a held thing would take in a lane if let go now. */
export interface Hover {
  lane: string;
  start: number;
  end: number;
  /** Alt is down: the technician joins the visit instead of taking it over. */
  add: boolean;
}

export interface Slot {
  start: number;
  end: number;
}

export interface LaneOps {
  canPlan: boolean;
  hold: (h: Held | null) => void;
  hover: (h: Hover | null, x?: number, y?: number) => void;
  drop: (lane: string, slot: Slot, add: boolean) => void;
  resize: (v: Visit, lane: string, slot: Slot) => void;
  select: (workOrder: string) => void;
  key: (e: KeyboardEvent, v: Visit, lane: string) => void;
  dismiss: (lane: string) => void;
}

/** Pixels of height for one stack of blocks in a lane. */
const ROW = 52;

const TAG: Record<string, string> = { get Scheduled() { return tr("Needs dispatch"); }, get "En Route"() { return tr("On the way"); }, get "On Site"() { return tr("On site"); }, get Completed() { return tr("Done"); }, get "Cannot Complete"() { return tr("Not finished"); } };

const slug = (status: string) => status.toLowerCase().replace(/\s+/g, "-");

function Block({ p, lane, axis, perMin, selected, held, tab, ops }: { p: Placed; lane: Lane; axis: Axis; perMin: number; selected: boolean; held: boolean; tab: boolean; ops: LaneOps }) {
  const v = p.visit;
  const pending = v.appointment.startsWith("pending-");
  const movable = ops.canPlan && isMovable(v) && !pending;
  const [edge, setEdge] = useState<Slot | null>(null);
  const resizing = useRef(false);
  const from = edge ? Math.max(0, at(axis, edge.start)) : p.from;
  const to = edge ? Math.min(axis.minutes, at(axis, edge.end)) : p.to;
  const [a, z] = edge ? [edge.start, edge.end] : [Date.parse(v.start), Date.parse(v.end)];
  const when = `${clock(a, axis.zone)}–${clock(z, axis.zone)}`;
  const tag = TAG[v.status];
  const late = p.late > 0 && p.travel ? tr("The drive from {origin} takes {minutes} min, but only {value} min are left after that job", { origin: p.travel.origin, minutes: p.travel.minutes, value: p.travel.minutes - p.late }) : "";

  // An edge is pulled with the pointer (a drag of the block itself is the browser's own).
  const grip = (side: "start" | "end") => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!movable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    resizing.current = true;
    const x0 = e.clientX;
    const base = { start: Date.parse(v.start), end: Date.parse(v.end) };
    const slotFor = (x: number) => resized(base, side, (x - x0) / perMin);
    let last = x0;
    const move = (ev: PointerEvent) => {
      last = ev.clientX;
      setEdge(slotFor(last));
    };
    const finish = (commit: boolean) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape);
      resizing.current = false;
      setEdge(null);
      const slot = slotFor(last);
      if (commit && (slot.start !== base.start || slot.end !== base.end)) ops.resize(v, lane.technician, slot);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const escape = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape);
  };

  const dragStart = (e: DragEvent<HTMLDivElement>) => {
    if (resizing.current) {
      e.preventDefault();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    e.dataTransfer.setData("text/plain", v.appointment);
    e.dataTransfer.effectAllowed = "copyMove";
    ops.hold({ kind: "visit", appointment: v.appointment, workOrder: v.work_order, from: lane.technician, minutes: Math.round((Date.parse(v.end) - Date.parse(v.start)) / MINUTE), grab: Math.max(0, (e.clientX - rect.left) / perMin), label: v.customer_name });
  };

  return (
    <>
      {p.travel && !edge && (
        <span
          className="fs-travel"
          data-late={p.late > 0 || undefined}
          style={{ left: p.travel.from * perMin, width: (p.travel.to - p.travel.from) * perMin, top: p.row * ROW + 50 }}
          title={tr("Drive from {value}: about {value2}", { value: p.travel.origin === "home" ? "home" : p.travel.origin, value2: span(p.travel.minutes * MINUTE) })}
        />
      )}
      <div
        className="fs-block"
        role="button"
        tabIndex={tab ? 0 : -1}
        data-appointment={v.appointment}
        data-status={slug(v.status)}
        data-priority={v.priority ?? undefined}
        data-selected={selected || undefined}
        data-held={held || undefined}
        data-late={p.late > 0 || undefined}
        data-pending={pending || undefined}
        data-cut-start={p.cutStart || undefined}
        data-cut-end={p.cutEnd || undefined}
        draggable={movable && !edge}
        aria-pressed={selected}
        aria-label={`${v.customer_name}, ${v.work_order_number}, ${when}, ${v.status}${late ? `. ${late}` : ""}`}
        title={`${v.customer_name} · ${v.work_order_number}\n${when} · ${v.status}${late ? `\n${late}` : ""}`}
        style={{ left: from * perMin, width: Math.max(10, (to - from) * perMin), top: p.row * ROW + 4 }}
        onDragStart={dragStart}
        onDragEnd={() => ops.hold(null)}
        onClick={() => ops.select(v.work_order)}
        onKeyDown={(e) => ops.key(e, v, lane.technician)}
      >
        {movable && <span className="fs-grip fs-grip-start" onPointerDown={grip("start")} aria-hidden="true" />}
        <span className="fs-block-title">
          {p.late > 0 && <Icon name="alert" size={12} />} {v.customer_name || v.work_order_number}
        </span>
        <span className="fs-block-sub">
          {isolate(when)}
          {tag ? ` · ${tag}` : ""}
        </span>
        {movable && <span className="fs-grip fs-grip-end" onPointerDown={grip("end")} aria-hidden="true" />}
      </div>
    </>
  );
}

function LaneRow({
  lane,
  axis,
  perMin,
  held,
  hover,
  selected,
  notice,
  tabId,
  ops,
}: {
  lane: Lane;
  axis: Axis;
  perMin: number;
  held: Held | null;
  hover: Hover | null;
  selected: string | null;
  notice?: string;
  tabId: string | null;
  ops: LaneOps;
}) {
  const { items, rows } = useMemo(() => place(lane, axis), [lane, axis]);
  const off = useMemo(() => offHours(lane, axis), [lane, axis]);
  const l = load(lane);
  const here = hover?.lane === lane.technician ? hover : null;

  // Both the pointer's position and what it holds decide the slot, so one place works it out.
  const slotOf = (e: DragEvent<HTMLDivElement>) => {
    if (!held) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    return slotAt(axis, (e.clientX - rect.left) / perMin, held.minutes, held.kind === "visit" ? held.grab : 0);
  };
  const adds = (e: DragEvent) => held?.kind === "visit" && (e.altKey || e.ctrlKey);
  const over = (e: DragEvent<HTMLDivElement>) => {
    const slot = slotOf(e);
    if (!slot || !ops.canPlan) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = adds(e) ? "copy" : "move";
    ops.hover({ lane: lane.technician, ...slot, add: adds(e) }, e.clientX, e.clientY);
  };
  const leave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ops.hover(null);
  };
  const drop = (e: DragEvent<HTMLDivElement>) => {
    const slot = slotOf(e);
    if (!slot || !ops.canPlan) return;
    e.preventDefault();
    ops.drop(lane.technician, slot, adds(e));
  };

  return (
    <div className="fs-lane" role="group" aria-label={`${lane.technician_name}, ${l.text}`}>
      <div className="fs-lane-head">
        <span className="fs-avatar" aria-hidden="true">
          {isolate(initials(lane.technician_name))}
        </span>
        <div className="fs-lane-who">
          <strong title={lane.technician_name}>{isolate(lane.technician_name)}</strong>
          <span className="faint fs-lane-load" data-over={l.over || undefined}>
            {isolate([lane.territory_name, l.text].filter(Boolean).join(" · "))}
          </span>
          {l.available !== null && l.available > 0 && (
            <span className="fs-meter" aria-hidden="true">
              <i style={{ width: `${Math.round(l.ratio * 100)}%` }} data-over={l.over || undefined} />
            </span>
          )}
        </div>
      </div>
      <div
        className="fs-track"
        data-droppable={(!!held && ops.canPlan) || undefined}
        style={{ width: axis.minutes * perMin, height: rows * ROW + 8 }}
        onDragOver={over}
        onDragLeave={leave}
        onDrop={drop}
      >
        {off.map((o) => (
          <span key={o.from} className="fs-off" style={{ left: o.from * perMin, width: (o.to - o.from) * perMin }} aria-hidden="true" />
        ))}
        {!items.length && <span className="fs-free faint">{l.available === 0 ? tr("Not working") : tr("No jobs")}</span>}
        {items.map((p) => (
          <Block key={p.visit.appointment} p={p} lane={lane} axis={axis} perMin={perMin} selected={selected === p.visit.work_order} held={held?.kind === "visit" && held.appointment === p.visit.appointment} tab={tabId === p.visit.appointment} ops={ops} />
        ))}
        {here && (
          <div className="fs-ghost" data-add={here.add || undefined} style={{ left: Math.max(0, at(axis, here.start)) * perMin, width: Math.max(10, (Math.min(axis.minutes, at(axis, here.end)) - Math.max(0, at(axis, here.start))) * perMin) }} aria-hidden="true">
            {here.add ? tr("Add · ") : ""}
            {isolate(clock(here.start, axis.zone))}–{isolate(clock(here.end, axis.zone))}
          </div>
        )}
        {notice && (
          <div className="fs-notice" role="alert">
            <span>{isolate(notice)}</span>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={tr("Dismiss")} onClick={() => ops.dismiss(lane.technician)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Grid({
  lanes,
  axis,
  perHour,
  now,
  held,
  hover,
  selected,
  notices,
  tabId,
  ops,
}: {
  lanes: Lane[];
  axis: Axis;
  perHour: number;
  now: number;
  held: Held | null;
  hover: Hover | null;
  selected: string | null;
  notices: Record<string, string>;
  tabId: string | null;
  ops: LaneOps;
}) {
  const perMin = perHour / 60;
  const every = perHour >= 56 ? 1 : 2;
  const nowAt = at(axis, now);
  const scroller = useRef<HTMLDivElement>(null);
  // A day wider than the screen opens at the present moment, when it is today.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = nowAt >= 0 && nowAt <= axis.minutes ? Math.max(0, nowAt * perMin - 200) : 0;
    // Only when the day changes: after that, scrolling it is the person's.
  }, [axis.day]);
  return (
    <div ref={scroller} className="fs-grid" role="region" tabIndex={0} aria-label={tr("Technicians across the day")} style={{ ["--fs-hour" as string]: `${perHour}px` }}>
      <div className="fs-grid-inner" style={{ minWidth: `calc(var(--fs-head) + ${axis.minutes * perMin}px)` }}>
        <div className="fs-ruler">
          <div className="fs-corner">{tr("Technician")}</div>
          <div className="fs-ticks" style={{ width: axis.minutes * perMin }} aria-hidden="true">
            {axis.ticks.slice(0, -1).map((t, i) =>
              i % every === 0 ? (
                <span key={t} style={{ left: at(axis, t) * perMin }}>
                  {isolate(hourLabel(t, axis.zone))}
                </span>
              ) : null,
            )}
          </div>
        </div>
        <div className="fs-lines" style={{ width: axis.minutes * perMin }} aria-hidden="true">
          {axis.ticks.map((t) => (
            <i key={t} style={{ left: at(axis, t) * perMin }} />
          ))}
          {nowAt >= 0 && nowAt <= axis.minutes && <b className="fs-now" style={{ left: nowAt * perMin }} title={tr("Now")} />}
        </div>
        {lanes.map((lane) => (
          <LaneRow key={lane.technician} lane={lane} axis={axis} perMin={perMin} held={held} hover={hover} selected={selected} notice={notices[lane.technician]} tabId={tabId} ops={ops} />
        ))}
      </div>
    </div>
  );
}
