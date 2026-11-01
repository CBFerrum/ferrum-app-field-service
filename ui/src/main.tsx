// Field Service's own interface (Ferrum docs/plan/apps-ui.md §13) at /field-service/: the dispatch
// board for those who plan the day, a technician's day and the job they are on for those who work
// it, a work order's page for the office, and every other record as lists and forms in the records
// frame, with Field Service's modules in the sidebar under the platform's bar. Every screen loads
// when it is first opened, so the first download holds only the frame (the size budget).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Navigate, RouterProvider, useRouteError } from "react-router";
import { routeBase, shell } from "@ferrum/client";
import { ConfirmHost, EmptyState, ErrorState, PageLoading, Toaster } from "@ferrum/kit";
import { useMe } from "@ferrum/records";
import { RequireAuth, setFrameMode } from "@ferrum/records/frame";
import { home } from "./roles";
import "./styles.css";

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
    <EmptyState title="Page not found">
      <Link to="/">Go to Field Service's home</Link>
    </EmptyState>
  );
}

/** Every page tells the shell it started. */
function Started() {
  useEffect(() => shell().ready(), []);
  return null;
}

/** Planners start on the board, everyone else on their day. */
function Landing() {
  const me = useMe();
  if (me.error) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data) return <PageLoading />;
  return <Navigate to={home(me.data.user)} replace />;
}

setFrameMode("app", FIELD_SERVICE_PACKAGES);

const router = createBrowserRouter(
  [
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
        { path: "day", lazy: () => import("./Day").then((m) => ({ Component: m.Day })) },
        { path: "w/:id", lazy: () => import("./Order").then((m) => ({ Component: m.OrderRoute })) },
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  </StrictMode>,
);
