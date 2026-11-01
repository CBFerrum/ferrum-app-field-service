// Motion a person has asked not to have.

/** How to scroll: smoothly, unless the person asked their device for less motion. */
export const scrollBehavior = (): ScrollBehavior => (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
