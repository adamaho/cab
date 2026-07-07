import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, PubSub, Ref, Stream } from "effect";
import { vi } from "vitest";

import { RouterCommand, RouterEvent } from "../src/event";
import { History, HistoryError, MemoryHistory } from "../src/history";
import { Router } from "../src/router";
import { initial, reduce } from "../src/state";

function fold(initialHref: string, events: ReadonlyArray<RouterEvent>) {
  return events.reduce(reduce, initial(initialHref));
}

function withRouter<A, E>(memory: MemoryHistory, program: Effect.Effect<A, E, Router>) {
  return Effect.provide(program, Router.layer.pipe(Layer.provide(memory.layer)));
}

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

describe("router", () => {
  it.effect("seeds state from history current", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/seeded");

      const state = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          return yield* router.state;
        }),
      );

      expect(state).toEqual({ href: "/seeded" });
    }),
  );

  it.effect("appends request and commit events for successful navigation", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;

          yield* router.dispatch(RouterCommand.NavigationRequested({ href: "/settings" }));
          yield* router.navigate("/billing");

          return {
            state: yield* router.state,
            journal: yield* router.journal,
          };
        }),
      );

      expect(result.state).toEqual({ href: "/billing" });
      expect(result.journal).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
        RouterEvent.NavigationCommitted({ sequence: 1, href: "/settings" }),
        RouterEvent.NavigationRequested({ sequence: 2, href: "/billing" }),
        RouterEvent.NavigationCommitted({ sequence: 3, href: "/billing" }),
      ]);
      expect(fold("/", result.journal)).toEqual(result.state);
      expect(yield* memory.pushes).toEqual(["/settings", "/billing"]);
    }),
  );

  it.effect("streams journal events for successful navigation", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const events = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          const fiber = yield* forkCollect(router.journalChanges, 2);

          yield* router.navigate("/settings");

          return yield* Fiber.join(fiber);
        }),
      );

      expect(events).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
        RouterEvent.NavigationCommitted({ sequence: 1, href: "/settings" }),
      ]);
    }),
  );

  it.effect("dedupes navigation to the current href", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;

          yield* router.navigate("/");

          return {
            state: yield* router.state,
            journal: yield* router.journal,
          };
        }),
      );

      expect(result.state).toEqual({ href: "/" });
      expect(result.journal).toEqual([]);
      expect(yield* memory.pushes).toEqual([]);
    }),
  );

  it.effect("does not stream journal events for deduped navigation", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const firstEvent = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          const fiber = yield* forkCollect(router.journalChanges, 1);

          yield* router.navigate("/");
          yield* router.navigate("/settings");

          return yield* Fiber.join(fiber);
        }),
      );

      expect(firstEvent).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
      ]);
    }),
  );

  it.effect("records observed navigation without pushing history", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          const stateReady = yield* Deferred.make<void>();
          const stateFiber = yield* router.stateChanges.pipe(
            Stream.tap(() => Deferred.succeed(stateReady, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          const eventFiber = yield* forkCollect(router.journalChanges, 1);

          yield* Deferred.await(stateReady);
          yield* memory.observe("/external");
          yield* Fiber.join(stateFiber);

          return {
            event: yield* Fiber.join(eventFiber),
            state: yield* router.state,
            journal: yield* router.journal,
          };
        }),
      );

      expect(result.state).toEqual({ href: "/external" });
      expect(result.event).toEqual([
        RouterEvent.NavigationObserved({ sequence: 0, href: "/external" }),
      ]);
      expect(result.journal).toEqual([
        RouterEvent.NavigationObserved({ sequence: 0, href: "/external" }),
      ]);
      expect(fold("/", result.journal)).toEqual(result.state);
      expect(yield* memory.pushes).toEqual([]);
    }),
  );

  it.effect("emits state and journal changes for observed navigation", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          const stateReady = yield* Deferred.make<void>();
          const statesFiber = yield* router.stateChanges.pipe(
            Stream.tap(() => Deferred.succeed(stateReady, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          const eventsFiber = yield* forkCollect(router.journalChanges, 1);

          yield* Deferred.await(stateReady);
          yield* memory.observe("/external");

          return {
            states: yield* Fiber.join(statesFiber),
            events: yield* Fiber.join(eventsFiber),
          };
        }),
      );

      expect(result.states).toEqual([{ href: "/" }, { href: "/external" }]);
      expect(result.events).toEqual([
        RouterEvent.NavigationObserved({ sequence: 0, href: "/external" }),
      ]);
    }),
  );

  it.effect("dedupes observed navigation to the current href", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          const fiber = yield* forkCollect(router.journalChanges, 1);

          // Both valid interleavings pass: the consumer can process `/` before
          // `/external`, or the sliding buffer can coalesce directly to `/external`.
          yield* memory.observe("/");
          yield* memory.observe("/external");

          return {
            event: yield* Fiber.join(fiber),
            journal: yield* router.journal,
          };
        }),
      );

      expect(result.event).toEqual([
        RouterEvent.NavigationObserved({ sequence: 0, href: "/external" }),
      ]);
      expect(result.journal).toEqual([
        RouterEvent.NavigationObserved({ sequence: 0, href: "/external" }),
      ]);
    }),
  );

  it.effect("records failed navigation outcomes without changing state", () =>
    Effect.gen(function* () {
      const attemptsRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const cause = new Error("push failed");
      const historyLayer = Layer.succeed(History, {
        current: Effect.succeed("/"),
        changes: Stream.never,
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
            journal: yield* router.journal,
          };
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(result.state).toEqual({ href: "/" });
      expect(result.journal).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
        RouterEvent.NavigationFailed({
          sequence: 1,
          href: "/settings",
          reason: "push-failed",
          cause,
        }),
      ]);
      expect(fold("/", result.journal)).toEqual(result.state);
      expect(yield* Ref.get(attemptsRef)).toEqual(["/settings"]);
    }),
  );

  it.effect("streams journal events for failed navigation", () =>
    Effect.gen(function* () {
      const cause = new Error("push failed");
      const historyLayer = Layer.succeed(History, {
        current: Effect.succeed("/"),
        changes: Stream.never,
        push: Effect.fn("test.streamFailHistory.push")(function* () {
          return yield* Effect.fail(new HistoryError({ reason: "push-failed", cause }));
        }),
      });

      const events = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;
          const fiber = yield* forkCollect(router.journalChanges, 2);

          yield* router.navigate("/settings");

          return yield* Fiber.join(fiber);
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(events).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
        RouterEvent.NavigationFailed({
          sequence: 1,
          href: "/settings",
          reason: "push-failed",
          cause,
        }),
      ]);
    }),
  );

  it.effect("emits seeded state and committed navigation changes", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const values = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          const ready = yield* Deferred.make<void>();
          const fiber = yield* router.stateChanges.pipe(
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
        changes: Stream.never,
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

          expect(yield* Ref.get(pushesRef)).toEqual(["/a"]);
          expect(yield* router.journal).toEqual([
            RouterEvent.NavigationRequested({ sequence: 0, href: "/a" }),
          ]);

          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);

          return {
            state: yield* router.state,
            journal: yield* router.journal,
          };
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(result.state).toEqual({ href: "/b" });
      expect(result.journal).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/a" }),
        RouterEvent.NavigationCommitted({ sequence: 1, href: "/a" }),
        RouterEvent.NavigationRequested({ sequence: 2, href: "/b" }),
        RouterEvent.NavigationCommitted({ sequence: 3, href: "/b" }),
      ]);
      expect(fold("/", result.journal)).toEqual(result.state);
      expect(yield* Ref.get(pushesRef)).toEqual(["/a", "/b"]);
    }),
  );

  it.effect("does not double-record router-owned navigation as observed navigation", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const result = yield* withRouter(
        memory,
        Effect.gen(function* () {
          const router = yield* Router;

          yield* router.navigate("/settings");

          return {
            state: yield* router.state,
            journal: yield* router.journal,
          };
        }),
      );

      expect(result.state).toEqual({ href: "/settings" });
      expect(result.journal).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
        RouterEvent.NavigationCommitted({ sequence: 1, href: "/settings" }),
      ]);
      expect(yield* memory.pushes).toEqual(["/settings"]);
    }),
  );

  it.effect("re-reads current href before folding queued observations", () =>
    Effect.gen(function* () {
      const locationRef = yield* Ref.make("/b");
      const changesPubSub = yield* PubSub.unbounded<string>({ replay: 1 });
      const pushStarted = yield* Deferred.make<void>();
      const releasePush = yield* Deferred.make<void>();
      const reReadArmedRef = yield* Ref.make(false);
      const reReadAfterRelease = yield* Deferred.make<void>();
      const observe = Effect.fn("test.staleObservationHistory.observe")(function* (href: string) {
        yield* Ref.set(locationRef, href);
        yield* PubSub.publish(changesPubSub, href);
      });
      const historyLayer = Layer.succeed(History, {
        current: Effect.gen(function* () {
          const href = yield* Ref.get(locationRef);

          if (yield* Ref.get(reReadArmedRef)) {
            yield* Deferred.succeed(reReadAfterRelease, undefined);
          }

          return href;
        }),
        changes: Stream.fromPubSub(changesPubSub),
        push: Effect.fn("test.staleObservationHistory.push")(function* (href: string) {
          yield* Deferred.succeed(pushStarted, undefined);
          yield* Deferred.await(releasePush);
          yield* Ref.set(locationRef, href);
        }),
      });

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;

          const navigation = yield* router.navigate("/c").pipe(Effect.forkChild);

          yield* Deferred.await(pushStarted);
          yield* observe("/a");

          expect(yield* router.journal).toEqual([
            RouterEvent.NavigationRequested({ sequence: 0, href: "/c" }),
          ]);

          yield* Ref.set(reReadArmedRef, true);
          yield* Deferred.succeed(releasePush, undefined);
          yield* Fiber.join(navigation);
          yield* Deferred.await(reReadAfterRelease);

          return {
            state: yield* router.state,
            journal: yield* router.journal,
            current: yield* Ref.get(locationRef),
          };
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(result.current).toBe("/c");
      expect(result.state).toEqual({ href: "/c" });
      expect(result.journal).toEqual([
        RouterEvent.NavigationRequested({ sequence: 0, href: "/c" }),
        RouterEvent.NavigationCommitted({ sequence: 1, href: "/c" }),
      ]);
    }),
  );

  it.effect("keeps consuming observations after a current read fails", () =>
    Effect.gen(function* () {
      const locationRef = yield* Ref.make("/");
      const failNextRef = yield* Ref.make(false);
      const failedRead = yield* Deferred.make<void>();
      const changesPubSub = yield* PubSub.unbounded<string>({ replay: 1 });
      const observe = Effect.fn("test.recoveringObservationHistory.observe")(function* (
        href: string,
      ) {
        yield* Ref.set(locationRef, href);
        yield* PubSub.publish(changesPubSub, href);
      });
      const historyLayer = Layer.succeed(History, {
        current: Effect.gen(function* () {
          if (yield* Ref.get(failNextRef)) {
            yield* Ref.set(failNextRef, false);
            yield* Deferred.succeed(failedRead, undefined);
            return yield* Effect.fail(new HistoryError({ reason: "window-unavailable" }));
          }

          return yield* Ref.get(locationRef);
        }),
        changes: Stream.fromPubSub(changesPubSub),
        push: Effect.fn("test.recoveringObservationHistory.push")(function* (href: string) {
          yield* Ref.set(locationRef, href);
        }),
      });

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;
          const stateFiber = yield* forkCollect(router.stateChanges, 2);
          const fiber = yield* forkCollect(router.journalChanges, 1);

          yield* Ref.set(failNextRef, true);
          yield* observe("/x");
          yield* Deferred.await(failedRead);
          yield* observe("/y");

          return {
            events: yield* Fiber.join(fiber),
            states: yield* Fiber.join(stateFiber),
            state: yield* router.state,
            journal: yield* router.journal,
          };
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(result.events).toEqual([RouterEvent.NavigationObserved({ sequence: 0, href: "/y" })]);
      expect(result.states).toEqual([{ href: "/" }, { href: "/y" }]);
      expect(result.journal).toEqual([RouterEvent.NavigationObserved({ sequence: 0, href: "/y" })]);
      expect(result.state).toEqual({ href: "/y" });
      expect(fold("/", result.journal)).toEqual(result.state);
    }),
  );

  it.effect("observes browser popstate through the browser layer", () =>
    Effect.gen(function* () {
      const listenerReady = yield* Deferred.make<void>();

      class FakeWindow extends EventTarget {
        readonly pushCalls: Array<string> = [];
        location = { pathname: "/", search: "", hash: "" };
        history = {
          pushState: (_state: unknown, _unused: string, href: string) => {
            this.pushCalls.push(href);
            this.setHref(href);
          },
        };

        override addEventListener(
          type: string,
          callback: EventListenerOrEventListenerObject | null,
          options?: AddEventListenerOptions | boolean,
        ) {
          super.addEventListener(type, callback, options);
          Effect.runSync(Deferred.succeed(listenerReady, undefined));
        }

        setHref(href: string) {
          const url = new URL(href, "https://cab.test");
          this.location = {
            pathname: url.pathname,
            search: url.search,
            hash: url.hash,
          };
        }
      }

      const fakeWindow = new FakeWindow();

      const result = yield* Effect.gen(function* () {
        yield* Effect.sync(() => vi.stubGlobal("window", fakeWindow));

        return yield* Effect.gen(function* () {
          const router = yield* Router;
          const popStatesFiber = yield* forkCollect(router.stateChanges, 2);
          const popEventsFiber = yield* forkCollect(router.journalChanges, 1);

          yield* Deferred.await(listenerReady);
          yield* Effect.sync(() => {
            fakeWindow.setHref("/external?x=1#details");
            fakeWindow.dispatchEvent(new Event("popstate"));
          });

          const popStates = yield* Fiber.join(popStatesFiber);
          const popEvents = yield* Fiber.join(popEventsFiber);
          const navigateEventsFiber = yield* forkCollect(router.journalChanges, 2);

          yield* router.navigate("/pushed");

          return {
            popStates,
            popEvents,
            navigateEvents: yield* Fiber.join(navigateEventsFiber),
            state: yield* router.state,
            journal: yield* router.journal,
            pushCalls: fakeWindow.pushCalls,
          };
        }).pipe(Effect.provide(Router.layerBrowser));
      }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));

      expect(result.popStates).toEqual([{ href: "/" }, { href: "/external?x=1#details" }]);
      expect(result.popEvents).toEqual([
        RouterEvent.NavigationObserved({ sequence: 0, href: "/external?x=1#details" }),
      ]);
      expect(result.navigateEvents).toEqual([
        RouterEvent.NavigationRequested({ sequence: 1, href: "/pushed" }),
        RouterEvent.NavigationCommitted({ sequence: 2, href: "/pushed" }),
      ]);
      expect(result.state).toEqual({ href: "/pushed" });
      expect(result.journal).toEqual([
        RouterEvent.NavigationObserved({ sequence: 0, href: "/external?x=1#details" }),
        RouterEvent.NavigationRequested({ sequence: 1, href: "/pushed" }),
        RouterEvent.NavigationCommitted({ sequence: 2, href: "/pushed" }),
      ]);
      expect(result.pushCalls).toEqual(["/pushed"]);
    }),
  );
});
