import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Stream } from "effect";
import { vi } from "vitest";

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
          yield* memory.simulate("/observed");

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

  it.effect("installs the window listener before sampling the initial href", () =>
    Effect.gen(function* () {
      class FakeWindow extends EventTarget {
        location = { pathname: "/before", search: "", hash: "" };
        history = { pushState: () => undefined };

        override addEventListener(
          type: string,
          callback: EventListenerOrEventListenerObject | null,
          options?: AddEventListenerOptions | boolean,
        ) {
          super.addEventListener(type, callback, options);
          this.location = { pathname: "/after", search: "?ready=1", hash: "#mounted" };
        }
      }

      const fakeWindow = new FakeWindow();
      const initialHref = yield* Effect.gen(function* () {
        yield* Effect.sync(() => vi.stubGlobal("window", fakeWindow));

        return yield* Effect.gen(function* () {
          const history = yield* History;
          const observation = yield* history.observe;

          return observation.initialHref;
        }).pipe(Effect.provide(WindowHistory.layer), Effect.scoped);
      }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));

      expect(initialHref).toBe("/after?ready=1#mounted");
    }),
  );

  it.effect("retains every memory wakeup after observation linearizes", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");
      const observationReady = yield* Deferred.make<string>();
      const startConsuming = yield* Deferred.make<void>();
      const fiber = yield* Effect.gen(function* () {
        const history = yield* History;
        const observation = yield* history.observe;

        yield* Deferred.succeed(observationReady, observation.initialHref);
        yield* Deferred.await(startConsuming);

        return yield* observation.changes.pipe(Stream.take(3), Stream.runCollect);
      }).pipe(Effect.provide(memory.layer), Effect.scoped, Effect.forkChild);

      expect(yield* Deferred.await(observationReady)).toBe("/");

      yield* memory.simulate("/a");
      yield* memory.simulate("/b");
      yield* memory.simulate("/c");
      yield* Deferred.succeed(startConsuming, undefined);

      expect(yield* Fiber.join(fiber)).toEqual([undefined, undefined, undefined]);
      expect(yield* memory.current).toBe("/c");
    }),
  );

  it.effect("removes the window observation listener when its scope closes", () =>
    Effect.gen(function* () {
      class FakeWindow extends EventTarget {
        readonly removals: Array<string> = [];
        location = { pathname: "/", search: "", hash: "" };
        history = { pushState: () => undefined };

        override removeEventListener(
          type: string,
          callback: EventListenerOrEventListenerObject | null,
          options?: EventListenerOptions | boolean,
        ) {
          this.removals.push(type);
          super.removeEventListener(type, callback, options);
        }
      }

      const fakeWindow = new FakeWindow();

      yield* Effect.gen(function* () {
        yield* Effect.sync(() => vi.stubGlobal("window", fakeWindow));

        yield* Effect.gen(function* () {
          const history = yield* History;
          yield* history.observe;

          expect(fakeWindow.removals).toEqual([]);
        }).pipe(Effect.provide(WindowHistory.layer), Effect.scoped);
      }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));

      expect(fakeWindow.removals).toEqual(["popstate"]);
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
