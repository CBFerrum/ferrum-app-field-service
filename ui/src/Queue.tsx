// The waiting jobs, in the order the server gives them (priority, then response due), beside the
// lanes. A card is dragged onto a technician's lane; from a keyboard or a phone it is chosen and
// scheduled from the drawer, or with S to its best technician.

import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { Badge, Icon, StatePanel } from "@ferrum/kit";
import { type Held } from "./Lanes";
import { type Job, lengthOf } from "./board";
import { slaChip } from "./sla";
import { span, stamp, MINUTE } from "./time";
import { t, isolate } from "@ferrum/client";

const SKILLS_SHOWN = 3;

export function QueueCard({
  job,
  zone,
  now,
  selected,
  canPlan,
  tab,
  busy,
  onSelect,
  onHold,
  onKey,
}: {
  job: Job;
  zone: string;
  now: number;
  selected: boolean;
  canPlan: boolean;
  /** The card the arrow keys start from (the others are reached by arrows, not Tab). */
  tab: boolean;
  busy: boolean;
  onSelect: (workOrder: string) => void;
  onHold: (h: Held | null) => void;
  onKey: (e: KeyboardEvent, job: Job) => void;
}) {
  const sla = slaChip({ sla_status: job.sla_status, response_due: job.response_due, resolution_due: job.resolution_due, response_breached: job.response_breached }, now, zone);
  const minutes = lengthOf(job);
  const start = (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.setData("text/plain", job.work_order);
    e.dataTransfer.effectAllowed = "copyMove";
    onHold({ kind: "job", workOrder: job.work_order, minutes, label: job.customer_name });
  };
  return (
    <article
      className="fs-card"
      data-job={job.work_order}
      data-priority={job.priority ?? undefined}
      data-selected={selected || undefined}
      data-busy={busy || undefined}
      draggable={canPlan && !busy}
      tabIndex={tab ? 0 : -1}
      aria-label={`${job.priority ? t("{priority} priority, ", { priority: job.priority }) : ""}${job.customer_name}, ${job.number}${sla ? `, ${sla.text}` : ""}`}
      aria-pressed={selected}
      role="button"
      onDragStart={start}
      onDragEnd={() => onHold(null)}
      onClick={() => onSelect(job.work_order)}
      onKeyDown={(e) => onKey(e, job)}
    >
      <div className="fs-card-top">
        <strong className="fs-card-title">{job.customer_name || job.number}</strong>
        {(job.priority === "Urgent" || job.priority === "High") && <span className="fs-pri">{isolate(job.priority)}</span>}
      </div>
      <div className="fs-card-sub faint">{isolate([job.number, job.work_type, job.territory_name].filter(Boolean).join(" · "))}</div>
      {job.required_skills.length > 0 && (
        <div className="fs-card-skills">
          {job.required_skills.slice(0, SKILLS_SHOWN).map((s) => (
            <span key={s} className="fs-skill">
              {isolate(s)}
            </span>
          ))}
          {job.required_skills.length > SKILLS_SHOWN && <span className="fs-skill">+{job.required_skills.length - SKILLS_SHOWN}</span>}
        </div>
      )}
      {job.preferred_start && <div className="fs-card-sub faint">{t("Asked for")} {isolate(stamp(Date.parse(job.preferred_start), zone))}</div>}
      <div className="fs-card-foot">
        {sla ? (
          <Badge tone={sla.tone} title={sla.title}>
            {isolate(sla.text)}
          </Badge>
        ) : (
          <span className="faint">{t("No service level")}</span>
        )}
        <span className="faint fs-card-len" title={t("Planned length")}>
          <Icon name="timeline" size={12} /> {isolate(span(minutes * MINUTE))}
        </span>
      </div>
    </article>
  );
}

export function Queue({
  jobs,
  total,
  filtered,
  skills,
  skill,
  search,
  onSkill,
  onSearch,
  onClear,
  children,
}: {
  jobs: Job[];
  total: number;
  filtered: boolean;
  skills: string[];
  skill: string;
  search: string;
  onSkill: (s: string) => void;
  onSearch: (q: string) => void;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="fs-rail" aria-label={t("Waiting to be scheduled")}>
      <header className="fs-rail-head">
        <h2 className="fs-rail-title">
          {t("Waiting")} <span className="faint">{filtered ? t("{length} of {total}", { length: jobs.length, total }) : total}</span>
        </h2>
        <input className="input fs-rail-search" type="search" placeholder={t("Find a job…")} aria-label={t("Find a waiting job")} value={search} onChange={(e) => onSearch(e.target.value)} />
        {skills.length > 0 && (
          <select className="select fs-rail-skill" aria-label={t("Jobs that need a skill")} value={skill} onChange={(e) => onSkill(e.target.value)}>
            <option value="">{t("Any skill")}</option>
            {skills.map((s) => (
              <option key={s} value={s}>
                {isolate(s)}
              </option>
            ))}
          </select>
        )}
      </header>
      {jobs.length ? (
        <div className="fs-rail-list">{children}</div>
      ) : filtered ? (
        <StatePanel kind="no-matches" title={t("Nothing matches")} onClear={onClear} clearLabel={t("Show every waiting job")} />
      ) : (
        <StatePanel kind="empty" title={t("Nothing waiting")}>{t("Every open job has a time.")}</StatePanel>
      )}
    </aside>
  );
}
