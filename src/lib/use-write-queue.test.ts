import { act, renderHook, waitFor } from "@testing-library/react";

import { useWriteQueue } from "./use-write-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("useWriteQueue", () => {
  it("runs operations for one id in order and others independently", async () => {
    const { result } = renderHook(() => useWriteQueue());
    const log: string[] = [];
    const first = deferred();

    act(() => {
      void result.current.enqueue("a", async () => {
        log.push("a1 start");
        await first.promise;
        log.push("a1 end");
      });
      void result.current.enqueue("a", async () => {
        log.push("a2");
      });
      void result.current.enqueue("b", async () => {
        log.push("b1");
      });
    });

    await waitFor(() => expect(log).toEqual(["a1 start", "b1"]));
    expect(result.current.isPending("a")).toBe(true);
    await waitFor(() => expect(result.current.isPending("b")).toBe(false));

    await act(async () => first.resolve());
    await waitFor(() => expect(log).toEqual(["a1 start", "b1", "a1 end", "a2"]));
    await waitFor(() => expect(result.current.isPending("a")).toBe(false));
  });

  it("keeps the queue moving after a failed operation", async () => {
    const { result } = renderHook(() => useWriteQueue());
    const ran = vi.fn();

    await act(async () => {
      void result.current.enqueue("a", async () => {
        throw new Error("boom");
      });
      await result.current.enqueue("a", async () => ran());
    });

    expect(ran).toHaveBeenCalledOnce();
    expect(result.current.isPending("a")).toBe(false);
  });
});
