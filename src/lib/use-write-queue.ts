import { useCallback, useRef, useState } from "react";

/*
 * Serializes async writes per record id (the roster and the monster stable).
 * An operation runs only after every earlier one for the same id settles, so
 * read-modify-write handlers never race each other; different ids run
 * independently. `isPending(id)` drives per-row disabling while work is queued.
 * Operations handle their own errors; a rejection is swallowed so it can't
 * wedge the queue.
 */
export function useWriteQueue() {
  // Number of in-flight operations per id.
  const [pending, setPending] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const queues = useRef(new Map<string, Promise<void>>());

  const enqueue = useCallback(
    (id: string, op: () => Promise<void>): Promise<void> => {
      setPending((counts) => withCount(counts, id, 1));
      const run: Promise<void> = (queues.current.get(id) ?? Promise.resolve())
        .then(op)
        .catch(() => {})
        .finally(() => {
          if (queues.current.get(id) === run) queues.current.delete(id);
          setPending((counts) => withCount(counts, id, -1));
        });
      queues.current.set(id, run);
      return run;
    },
    [],
  );

  const isPending = (id: string) => (pending.get(id) ?? 0) > 0;

  return { enqueue, isPending };
}

function withCount(
  counts: ReadonlyMap<string, number>,
  id: string,
  delta: number,
): ReadonlyMap<string, number> {
  const next = new Map(counts);
  const count = (next.get(id) ?? 0) + delta;
  if (count > 0) next.set(id, count);
  else next.delete(id);
  return next;
}
