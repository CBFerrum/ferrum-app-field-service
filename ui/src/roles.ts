// Who does what in Field Service, as the platform's roles name it. Dispatchers and service
// managers plan the day; technicians work it. The server enforces both; the screens only choose
// which one to start on and what to offer.

export interface Who {
  is_admin?: boolean;
  roles?: string[];
}

/** Plans and dispatches: the dispatch board is theirs. */
export const plans = (u: Who | undefined | null) => !!u && (!!u.is_admin || !!u.roles?.some((r) => r === "Dispatcher" || r === "Service Manager"));

/** Works jobs in the field: has a day of their own. */
export const works = (u: Who | undefined | null) => !!u && !!u.roles?.includes("Technician");

/** Where Field Service opens for a person. */
export const home = (u: Who | undefined | null) => (plans(u) ? "/dispatch" : "/day");
