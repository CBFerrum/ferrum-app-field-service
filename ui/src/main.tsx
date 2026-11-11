// Field Service's own interface (Ferrum docs/plan/apps-ui.md §13) at /field-service/: the dispatch
// board for those who plan the day, a technician's day and the job they are on for those who work
// it, a work order's page for the office, and every other record as lists and forms in the records
// frame, with Field Service's modules in the sidebar under the platform's bar. Every screen loads
// when it is first opened, so the first download holds only the frame (the size budget).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useRouteError } from "react-router";
import { addCatalogs, routeBase, shell, t, wordsReady } from "@ferrum/client";
import { ConfirmHost, EmptyState, ErrorState, PageLoading, Toaster } from "@ferrum/kit";
import { useMe, useMetaIndex } from "@ferrum/records";
import { RequireAuth, setFrameMode } from "@ferrum/records/frame";
import { keepToTheLease, unreachable } from "./offline";
import { Failure } from "./Stale";
import { home } from "./roles";
import "./styles.css";

// Its own words in the page's language (src/locales), fetched as the page starts; it is drawn once they are in.
void addCatalogs({ ar: () => import("./locales/ar.json"), hi: () => import("./locales/hi.json") });

/** A page of the records frame, loaded when first opened. */
const page = (name: "FormView" | "ListView" | "ReportView" | "AppSettingsPage" | "ScreenPage") => () =>
  import("./records").then((m) => ({ Component: m[name] }));

/** Field Service's package: the sidebar shows its modules. */
const FIELD_SERVICE_PACKAGES = ["field_service"];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

function RouteError() {
  return <ErrorState error={useRouteError()} onRetry={() => window.location.reload()} />;
}

function NotFound() {
  return (
    <EmptyState title={t("Page not found")}>
      <Link to="/">{t("Go to Field Service's home")}</Link>
    </EmptyState>
  );
}

/** Every page tells the shell it started. */
function Started() {
  useEffect(() => shell().ready(), []);
  return null;
}

/** A page on its own, outside the frame (which needs the server). */
function Bare() {
  return (
    <main id="main" tabIndex={-1}>
      <Outlet />
    </main>
  );
}

/** A job opens in the frame; without a connection the frame cannot load, and the job opens on its
 *  own from what this phone kept (offline.ts). */
function JobFrame() {
  return unreachable(useMetaIndex().error) ? <Bare /> : <RequireAuth />;
}

/** Planners start on the board, everyone else on their day. */
function Landing() {
  const me = useMe();
  if (me.error) return <Failure error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data) return <PageLoading />;
  return <Navigate to={home(me.data.user)} replace />;
}

setFrameMode("app", FIELD_SERVICE_PACKAGES);
keepToTheLease();

// The technician's day and its jobs open without a connection under this app's own worker; one that cannot
// register (a private window, an old browser) leaves it working online.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register(`${routeBase("field-service")}sw.js`, { scope: routeBase("field-service") }).catch(() => {});
}

const router = createBrowserRouter(
  [
    // The day works offline: outside the sign-in check, which asks the server who is signed in.
    {
      path: "/day",
      element: (
        <>
          <Started />
          <Bare />
        </>
      ),
      errorElement: <RouteError />,
      children: [{ index: true, lazy: () => import("./Day").then((m) => ({ Component: m.Day })) }],
    },
    {
      path: "/w/:id",
      element: (
        <>
          <Started />
          <JobFrame />
        </>
      ),
      errorElement: <RouteError />,
      children: [{ index: true, lazy: () => import("./Order").then((m) => ({ Component: m.OrderRoute })) }],
    },
    {
      path: "/",
      element: (
        <>
          <Started />
          <RequireAuth />
        </>
      ),
      errorElement: <RouteError />,
      children: [
        { index: true, element: <Landing /> },
        { path: "dispatch", lazy: () => import("./Dispatch").then((m) => ({ Component: m.Dispatch })) },
        { path: "e/:entity", lazy: page("ListView") },
        { path: "e/:entity/:id", lazy: page("FormView") },
        { path: "r/:name", lazy: page("ReportView") },
        { path: "apps/:app/settings", lazy: page("AppSettingsPage") },
        { path: "x/:app/:page", lazy: page("ScreenPage") },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: routeBase("field-service") },
);

// Drawn once the page's words are in (its language's catalogs, fetched as the page starts).
void wordsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
        <ConfirmHost />
      </QueryClientProvider>
    </StrictMode>,
  ),
);
