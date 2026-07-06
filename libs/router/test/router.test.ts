import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";

import { RouterCommand, RouterEvent } from "../src/event";
import { History, HistoryError, MemoryHistory } from "../src/history";
import { Router } from "../src/router";
import { initial, reduce } from "../src/state";

function fold(initialHref: string, events: ReadonlyArray<RouterEvent>) {
  return events.reduce(reduce, initial(initialHref));
}

describe("router", () => {
  it.effect("seeds state from history current", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/seeded");

      const state = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;
          return yield* router.state;
        }),
        Router.layer.pipe(Layer.provide(memory.layer)),
      );

      expect(state).toEqual({ href: "/seeded" });
    }),
  );

  it.effect("appends request and commit events for successful navigation", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;

          yield* router.dispatch(RouterCommand.NavigationRequested({ href: "/settings" }));
          yield* router.navigate("/billing");

          return {
            state: yield* router.state,
            events: yield* router.events,
          };
        }),
        Router.layer.pipe(Layer.provide(memory.layer)),
      );

      expect(result.state).toEqual({ href: "/billing" });
      expect(result.events).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
        RouterEvent.NavigationCommitted({ sequence: 1, href: "/settings" }),
        RouterEvent.NavigationRequested({ sequence: 2, href: "/billing" }),
        RouterEvent.NavigationCommitted({ sequence: 3, href: "/billing" }),
      ]);
      expect(fold("/", result.events)).toEqual(result.state);
      expect(yield* memory.pushes).toEqual(["/settings", "/billing"]);
    }),
  );

  it.effect("dedupes navigation to the current href", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;

          yield* router.navigate("/");

          return {
            state: yield* router.state,
            events: yield* router.events,
          };
        }),
        Router.layer.pipe(Layer.provide(memory.layer)),
      );

      expect(result.state).toEqual({ href: "/" });
      expect(result.events).toEqual([]);
      expect(yield* memory.pushes).toEqual([]);
    }),
  );

  it.effect("records failed navigation outcomes without changing state", () =>
    Effect.gen(function* () {
      const attemptsRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const cause = new Error("push failed");
      const historyLayer = Layer.succeed(History, {
        current: Effect.succeed("/"),
        push: Effect.fn("test.failHistory.push")(function* (href: string) {
          yield* Ref.update(attemptsRef, (attempts) => [...attempts, href]);
          return yield* Effect.fail(new HistoryError({ reason: "push-failed", cause }));
        }),
      });

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;

          yield* router.navigate("/settings");

          return {
            state: yield* router.state,
            events: yield* router.events,
          };
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(result.state).toEqual({ href: "/" });
      expect(result.events).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
        RouterEvent.NavigationFailed({
          sequence: 1,
          href: "/settings",
          reason: "push-failed",
          cause,
        }),
      ]);
      expect(fold("/", result.events)).toEqual(result.state);
      expect(yield* Ref.get(attemptsRef)).toEqual(["/settings"]);
    }),
  );

  it.effect("emits seeded state and committed navigation changes", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const values = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;
          const ready = yield* Deferred.make<void>();
          const fiber = yield* router.changes.pipe(
            Stream.tap(() => Deferred.succeed(ready, undefined)),
            Stream.take(3),
            Stream.runCollect,
            Effect.forkChild,
          );

          yield* Deferred.await(ready);
          yield* router.navigate("/settings");
          yield* router.navigate("/billing");

          return yield* Fiber.join(fiber);
        }),
        Router.layer.pipe(Layer.provide(memory.layer)),
      );

      expect(values).toEqual([{ href: "/" }, { href: "/settings" }, { href: "/billing" }]);
    }),
  );

  it.effect("processes concurrent navigations one at a time", () =>
    Effect.gen(function* () {
      const startedFirst = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const pushesRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const historyLayer = Layer.succeed(History, {
        current: Effect.succeed("/"),
        push: Effect.fn("test.serialHistory.push")(function* (href: string) {
          yield* Ref.update(pushesRef, (pushes) => [...pushes, href]);

          if (href === "/a") {
            yield* Deferred.succeed(startedFirst, undefined);
            yield* Deferred.await(releaseFirst);
          }
        }),
      });

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;
          const first = yield* router.navigate("/a").pipe(Effect.forkChild);

          yield* Deferred.await(startedFirst);

          const second = yield* router.navigate("/b").pipe(Effect.forkChild);

          yield* Effect.yieldNow;

          expect(yield* Ref.get(pushesRef)).toEqual(["/a"]);
          expect(yield* router.events).toEqual([
            RouterEvent.NavigationRequested({ sequence: 0, href: "/a" }),
          ]);

          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);

          return {
            state: yield* router.state,
            events: yield* router.events,
          };
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(result.state).toEqual({ href: "/b" });
      expect(result.events).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/a" }),
        RouterEvent.NavigationCommitted({ sequence: 1, href: "/a" }),
        RouterEvent.NavigationRequested({ sequence: 2, href: "/b" }),
        RouterEvent.NavigationCommitted({ sequence: 3, href: "/b" }),
      ]);
      expect(fold("/", result.events)).toEqual(result.state);
      expect(yield* Ref.get(pushesRef)).toEqual(["/a", "/b"]);
    }),
  );
});
