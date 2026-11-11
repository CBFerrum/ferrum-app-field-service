// A screen that already has its data keeps it when the next read fails: a technician in a basement
// still sees the job they opened, with a way to try again, rather than an error page.

import { errorMessage, t, isolate } from "@ferrum/client";
import { Alert, Button, StatePanel } from "@ferrum/kit";

export function Stale({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert
      tone="warning"
      action={
        <Button size="sm" icon="refresh" onClick={onRetry}>
          {t("Try again")}
        </Button>
      }
    >
      {isolate(errorMessage(error, false))} {t("What you see is how it was when you last had a connection.")}
    </Alert>
  );
}

/** A screen with nothing to show because its read failed: denied, offline or failed, by what the error says. */
export function Failure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = (error as { status?: number } | null)?.status;
  if (status === 403) return <StatePanel kind="denied" />;
  if (error instanceof TypeError || status === 0) return <StatePanel kind="offline" onRetry={onRetry} />;
  return <StatePanel kind="failed" error={error} onRetry={onRetry} />;
}
