// Field Service's own screens, at the top of each: the board for those who plan the day, and the
// day for those who work it.

import { NavLink } from "react-router";
import { useMe } from "@ferrum/records";
import { plans, works } from "./roles";
import { t } from "@ferrum/client";

export function Tabs() {
  const user = useMe().data?.user;
  const planner = plans(user);
  return (
    <nav className="fs-tabs" aria-label={t("Field Service")}>
      {planner && <NavLink to="/dispatch">{t("Dispatch")}</NavLink>}
      {/* Whoever does not plan has the day, so nobody lands on a page with nothing to go to. */}
      {user && (works(user) || !planner) && <NavLink to="/day">{t("My day")}</NavLink>}
    </nav>
  );
}
