// A week at a glance: each technician's days as how full they are, to find the day with room or the
// one that is too full, and open it on the board.

import { initials, t, isolate } from "@ferrum/client";
import { type Board, weekOf } from "./board";
import { hoursText } from "./job";
import { dayLabel } from "./time";

export function Week({ board, first, today, onOpen }: { board: Board; first: string; today: string; onOpen: (day: string) => void }) {
  const { days, rows } = weekOf(board, first);
  return (
    <div className="fs-week-wrap" role="region" tabIndex={0} aria-label={t("The week")}>
      <table className="fs-week">
        <thead>
          <tr>
            <th scope="col" className="fs-week-who">
              {t("Technician")}
            </th>
            {days.map((d) => (
              <th key={d} scope="col" data-today={d === today || undefined}>
                {isolate(dayLabel(d, { weekday: "short", day: "numeric" }))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ lane, cells }) => (
            <tr key={lane.technician}>
              <th scope="row" className="fs-week-who">
                <span className="fs-avatar" aria-hidden="true">
                  {isolate(initials(lane.technician_name))}
                </span>
                <span className="fs-week-name">
                  {isolate(lane.technician_name)}
                  {lane.territory_name && <small className="faint">{isolate(lane.territory_name)}</small>}
                </span>
              </th>
              {cells.map((c) => {
                const off = c.available === 0 && !c.visits;
                const text = off ? "Off" : c.available === null ? (c.booked ? `${hoursText(c.booked)} h` : "Free") : t("{value} of {value2} h", { value: hoursText(c.booked), value2: hoursText(c.available) });
                const jobs = c.visits ? `${c.visits} ${c.visits === 1 ? "job" : "jobs"}` : "";
                const ratio = c.available ? Math.min(1, c.booked / c.available) : c.booked ? 1 : 0;
                return (
                  <td key={c.day} data-today={c.day === today || undefined} data-off={off || undefined} data-over={c.over || undefined}>
                    <button type="button" onClick={() => onOpen(c.day)} aria-label={t("{technician_name}, {value}: {text}{value2}{value3}. Open the day", { technician_name: lane.technician_name, value: dayLabel(c.day, { weekday: "long", day: "numeric", month: "long" }), text, value2: jobs ? `, ${jobs}` : "", value3: c.over ? ", booked past their hours" : "" })}>
                      <strong>{isolate(text)}</strong>
                      {jobs && <small>{isolate(jobs)}</small>}
                      {!off && (
                        <span className="fs-meter" aria-hidden="true">
                          <i style={{ width: `${Math.round(ratio * 100)}%` }} data-over={c.over || undefined} />
                        </span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
