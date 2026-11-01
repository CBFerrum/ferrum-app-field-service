// Writes to one record, one after another. A change made on a phone is built on the ones before it
// (a tick on a list whose earlier tick is still on its way), so if one is refused, those queued
// behind it are dropped rather than sent: they would put the refused change back.

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  /** Jobs queued or running. */
  pending = 0;

  get idle() {
    return this.pending === 0;
  }

  /** Queues a job. It resolves to null, untouched, when a job queued before it failed; a job
   *  fails when `ok` says its result is not good, or when it throws. */
  add<T>(job: () => Promise<T>, ok: (result: T) => boolean = () => true): Promise<T | null> {
    const mine = this.epoch;
    this.pending++;
    const done = this.tail.then(async () => {
      try {
        if (mine !== this.epoch) return null;
        const result = await job();
        if (!ok(result)) this.epoch++;
        return result;
      } catch (e) {
        this.epoch++;
        throw e;
      } finally {
        this.pending--;
      }
    });
    this.tail = done.catch(() => null);
    return done;
  }
}
