// A screen that already has its data keeps it when the next read fails: a technician in a basement
// still sees the job they opened, with a way to try again, rather than an error page.

import { errorMessage } from "@ferrum/client";
import { Alert, Button } from "@ferrum/kit";

export function Stale({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert
      tone="warning"
      action={
        <Button size="sm" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {errorMessage(error, false)} What you see is how it was when you last had a connection.
    </Alert>
  );
}
