import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Fiber, Stream } from "effect";

import { History, HistoryError, MemoryHistory, WindowHistory } from "../src/history";

/**
 * Forks live-stream collection after giving the child fiber one run slice.
 *
 * Guarantee: `Stream.fromPubSub` acquires its subscription synchronously on the
 * forked fiber's first run slice, so one parent yield lets the child run from
 * fork to its first suspension point at `PubSub.take`.
 */
function forkCollect<A, E>(stream: Stream.Stream<A, E>, n: number) {
  return stream
    .pipe(Stream.take(n), Stream.runCollect, Effect.forkChild)
    .pipe(Effect.tap(() => Effect.yieldNow));
}

describe("history", () => {
  it.effect("creates memory-backed history layers with observable state", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const program = Effect.gen(function* () {
        const history = yield* History;

        expect(yield* history.current).toBe("/");

        yield* history.push("/settings?tab=profile#details");

        expect(yield* history.current).toBe("/settings?tab=profile#details");
      });

      yield* Effect.provide(program, memory.layer);

      expect(yield* memory.current).toBe("/settings?tab=profile#details");
      expect(yield* memory.pushes).toEqual(["/settings?tab=profile#details"]);
    }),
  );

  it.effect("records memory pushes in order", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const program = Effect.gen(function* () {
        const history = yield* History;

        yield* history.push("/a");
        yield* history.push("/b");
      });

      yield* Effect.provide(program, memory.layer);

      expect(yield* memory.current).toBe("/b");
      expect(yield* memory.pushes).toEqual(["/a", "/b"]);
    }),
  );

  it.effect("streams memory observations without treating pushes as changes", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const history = yield* History;
          const fiber = yield* forkCollect(history.changes, 1);

          yield* history.push("/pushed");
          yield* memory.observe("/observed");

          return {
            changes: yield* Fiber.join(fiber),
            current: yield* history.current,
          };
        }),
        memory.layer,
      );

      expect(result.changes).toEqual(["/observed"]);
      expect(result.current).toBe("/observed");
      expect(yield* memory.current).toBe("/observed");
      expect(yield* memory.pushes).toEqual(["/pushed"]);
    }),
  );

  it.effect("fails the window layer when window is unavailable", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(Effect.provide(History, WindowHistory.layer));

      expect(result._tag).toBe("Failure");

      if (result._tag === "Failure") {
        const reason = result.cause.reasons[0];

        expect(Cause.isFailReason(reason)).toBe(true);

        if (Cause.isFailReason(reason)) {
          expect(reason.error).toEqual(new HistoryError({ reason: "window-unavailable" }));
        }
      }
    }),
  );
});
