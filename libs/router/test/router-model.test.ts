import type { Sequenced } from "@cab/store";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Layer, ManagedRuntime, Queue, Ref, Stream } from "effect";

import { History, MemoryHistory } from "../src/history";
import { Router, RouterModel } from "../src/router";
import { RouterCommand, RouterEvent, type RouterEvent as RouterEventType } from "../src/slice";

function fact(sequence: number, event: RouterEventType): Sequenced<RouterEventType> {
  return { sequence, event };
}

function withModel<A, E>(
  model: RouterModel,
  memory: MemoryHistory,
  program: Effect.Effect<A, E, Router>,
) {
  return Effect.provide(program, Router.layerFromModel(model).pipe(Layer.provide(memory.layer)));
}

describe("router model", () => {
  it("exposes the initial state synchronously", () => {
    const model = RouterModel.make("/seed");

    expect(model.reader.getSnapshot()).toEqual({ href: "/seed" });
    expect("dispatch" in model.reader).toBe(false);
  });

  it.effect("publishes the exact model reader from a model-backed service", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/seed");
      const memory = yield* MemoryHistory.make("/seed");

      const reader = yield* withModel(
        model,
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          return router.reader;
        }),
      );

      expect(reader).toBe(model.reader);
    }),
  );

  it.effect("navigates through a pre-existing model", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/seed");
      const memory = yield* MemoryHistory.make("/seed");

      yield* withModel(
        model,
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          yield* router.navigate("/settings");
        }),
      );

      expect(model.reader.getSnapshot()).toEqual({ href: "/settings" });
      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationRequested({ href: "/settings" })),
        fact(1, RouterEvent.NavigationCommitted({ href: "/settings" })),
      ]);
    }),
  );

  it.effect("preserves reader, state, journal, and sequence across sequential lifetimes", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/seed");
      const reader = model.reader;
      const memory = yield* MemoryHistory.make("/seed");

      const firstReader = yield* withModel(
        model,
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          yield* router.navigate("/first");
          return router.reader;
        }),
      );

      yield* memory.simulate("/between");

      const secondReader = yield* withModel(
        model,
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          yield* router.navigate("/second");
          return router.reader;
        }),
      );

      expect(firstReader).toBe(reader);
      expect(secondReader).toBe(reader);
      expect(model.reader.getSnapshot()).toEqual({ href: "/second" });
      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationRequested({ href: "/first" })),
        fact(1, RouterEvent.NavigationCommitted({ href: "/first" })),
        fact(2, RouterEvent.NavigationObserved({ href: "/between" })),
        fact(3, RouterEvent.NavigationRequested({ href: "/second" })),
        fact(4, RouterEvent.NavigationCommitted({ href: "/second" })),
      ]);
    }),
  );

  it.effect("stale model-backed service commands die without changing the model", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/");
      const memory = yield* MemoryHistory.make("/");
      const stale = yield* withModel(model, memory, Router);

      const dispatchExit = yield* stale
        .dispatch(RouterCommand.NavigationRequested({ href: "/stale-dispatch" }))
        .pipe(Effect.exit);
      const navigateExit = yield* stale.navigate("/stale-navigate").pipe(Effect.exit);

      for (const exit of [dispatchExit, navigateExit]) {
        expect(exit._tag).toBe("Failure");

        if (exit._tag === "Failure") {
          const reason = exit.cause.reasons.find(Cause.isDieReason);
          const defect = reason?.defect;

          expect(defect).toBeInstanceOf(Error);

          if (defect instanceof Error) {
            expect(defect.message).toContain(
              "Cannot dispatch through a router process after its layer has been released",
            );
          }
        }
      }

      expect(yield* model.reader.journal).toEqual([]);

      yield* withModel(
        model,
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          yield* router.navigate("/active");
        }),
      );

      expect(model.reader.getSnapshot()).toEqual({ href: "/active" });
      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationRequested({ href: "/active" })),
        fact(1, RouterEvent.NavigationCommitted({ href: "/active" })),
      ]);
    }),
  );

  it.effect("revalidates queued stale commands after acquiring the semaphore", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/");
      const pushStarted = yield* Deferred.make<void>();
      const finishPush = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const historyLayer = Layer.succeed(History, {
        push: (href: string) =>
          href === "/first"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(pushStarted, undefined);
                yield* Deferred.await(finishPush);
              })
            : Effect.void,
        current: Effect.succeed("/"),
        changes: Stream.never,
        observe: Effect.succeed({ initialHref: "/", changes: Stream.never }),
      });
      const runtime = ManagedRuntime.make(
        Router.layerFromModel(model).pipe(Layer.provide(historyLayer)),
      );
      const stale = yield* Effect.promise(() => runtime.runPromise(Router));
      const first = yield* stale.navigate("/first").pipe(Effect.forkChild);

      yield* Deferred.await(pushStarted);

      const second = yield* Effect.gen(function* () {
        yield* Deferred.succeed(secondStarted, undefined);
        yield* stale.navigate("/second");
      }).pipe(Effect.forkChild);

      yield* Deferred.await(secondStarted);
      yield* Effect.yieldNow;
      yield* Effect.promise(() => runtime.dispose());
      yield* Deferred.succeed(finishPush, undefined);

      const firstExit = yield* Fiber.await(first);
      const secondExit = yield* Fiber.await(second);

      expect(firstExit._tag).toBe("Success");
      expect(secondExit._tag).toBe("Failure");

      if (secondExit._tag === "Failure") {
        const reason = secondExit.cause.reasons.find(Cause.isDieReason);
        const defect = reason?.defect;

        expect(defect).toBeInstanceOf(Error);

        if (defect instanceof Error) {
          expect(defect.message).toContain(
            "Cannot dispatch through a router process after its layer has been released",
          );
        }
      }

      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationRequested({ href: "/first" })),
        fact(1, RouterEvent.NavigationCommitted({ href: "/first" })),
      ]);
    }),
  );

  it.effect("rejects concurrent processes for one model with a descriptive defect", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/");
      const memory = yield* MemoryHistory.make("/");
      const mounted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const active = yield* withModel(
        model,
        memory,
        Effect.gen(function* () {
          yield* Router;
          yield* Deferred.succeed(mounted, undefined);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(mounted);

      const collision = yield* withModel(model, memory, Router).pipe(Effect.exit);

      expect(collision._tag).toBe("Failure");

      if (collision._tag === "Failure") {
        const reason = collision.cause.reasons.find(Cause.isDieReason);
        const defect = reason?.defect;

        expect(defect).toBeInstanceOf(Error);

        if (defect instanceof Error) {
          expect(defect.message).toContain("more than one router process for the same RouterModel");
        }
      }

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(active);
    }),
  );
});

describe("model-backed router startup", () => {
  it.effect("uses listener-first observation without a legacy pre-listener current read", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const historyLayer = Layer.succeed(History, {
        push: () => Effect.void,
        current: Effect.sync(() => {
          order.push("current");
          return "/current";
        }),
        changes: Stream.never,
        observe: Effect.acquireRelease(
          Effect.sync(() => {
            order.push("listener");
            order.push("sample");
            return { initialHref: "/observed", changes: Stream.never };
          }),
          () => Effect.void,
        ),
      });

      const state = yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;
          return router.reader.getSnapshot();
        }),
        Router.layer.pipe(Layer.provide(historyLayer)),
      );

      expect(state).toEqual({ href: "/observed" });
      expect(order).toEqual(["listener", "sample"]);
    }),
  );

  it.effect("catches up exactly once when history drifts before mount", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/seed");
      const memory = yield* MemoryHistory.make("/seed");

      yield* memory.simulate("/drift");
      yield* withModel(model, memory, Router);

      expect(model.reader.getSnapshot()).toEqual({ href: "/drift" });
      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationObserved({ href: "/drift" })),
      ]);
    }),
  );

  it.effect("does not lose a history change during startup", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/seed");
      const location = yield* Ref.make("/before");
      const wakeups = yield* Queue.unbounded<void>();
      const applied = yield* Deferred.make<void>();
      const unsubscribe = model.reader.subscribeJournal(({ event }) => {
        if (event._tag === "NavigationObserved" && event.href === "/during") {
          Deferred.doneUnsafe(applied, Effect.void);
        }
      });
      const historyLayer = Layer.succeed(History, {
        push: (href: string) => Ref.set(location, href),
        current: Ref.get(location),
        changes: Stream.never,
        observe: Effect.gen(function* () {
          const initialHref = yield* Ref.get(location);

          yield* Ref.set(location, "/during");
          yield* Queue.offer(wakeups, undefined);

          return { initialHref, changes: Stream.fromQueue(wakeups) };
        }),
      });

      yield* Effect.provide(
        Deferred.await(applied),
        Router.layerFromModel(model).pipe(Layer.provide(historyLayer)),
      ).pipe(Effect.ensuring(Effect.sync(unsubscribe)));

      expect(model.reader.getSnapshot()).toEqual({ href: "/during" });
      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationObserved({ href: "/before" })),
        fact(1, RouterEvent.NavigationObserved({ href: "/during" })),
      ]);
    }),
  );

  it.effect("completes initial catch-up before the first waiting command", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/seed");
      const memory = yield* MemoryHistory.make("/mounted");

      yield* withModel(
        model,
        memory,
        Effect.gen(function* () {
          const router = yield* Router;
          yield* router.navigate("/command");
        }),
      );

      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationObserved({ href: "/mounted" })),
        fact(1, RouterEvent.NavigationRequested({ href: "/command" })),
        fact(2, RouterEvent.NavigationCommitted({ href: "/command" })),
      ]);
    }),
  );

  it.effect("releases the history listener and model lease on layer release", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/");
      let listeners = 0;
      const historyLayer = Layer.succeed(History, {
        push: () => Effect.void,
        current: Effect.succeed("/"),
        changes: Stream.never,
        observe: Effect.acquireRelease(
          Effect.sync(() => {
            listeners += 1;
            return { initialHref: "/", changes: Stream.never };
          }),
          () =>
            Effect.sync(() => {
              listeners -= 1;
            }),
        ),
      });
      const layer = Router.layerFromModel(model).pipe(Layer.provide(historyLayer));

      yield* Effect.provide(Router, layer);
      expect(listeners).toBe(0);

      const reader = yield* Effect.provide(
        Effect.gen(function* () {
          expect(listeners).toBe(1);
          return (yield* Router).reader;
        }),
        layer,
      );

      expect(reader).toBe(model.reader);
      expect(listeners).toBe(0);
    }),
  );

  it.effect("leaves a request-only journal when teardown interrupts a history push", () =>
    Effect.gen(function* () {
      const model = RouterModel.make("/");
      const pushStarted = yield* Deferred.make<void>();
      const finishPush = yield* Deferred.make<void>();
      const historyLayer = Layer.succeed(History, {
        push: Effect.fn("test.interruptedHistory.push")(function* () {
          yield* Deferred.succeed(pushStarted, undefined);
          yield* Deferred.await(finishPush);
        }),
        current: Effect.succeed("/"),
        changes: Stream.never,
        observe: Effect.succeed({ initialHref: "/", changes: Stream.never }),
      });

      yield* Effect.provide(
        Effect.gen(function* () {
          const router = yield* Router;
          yield* router.navigate("/slow").pipe(Effect.forkChild);
          yield* Deferred.await(pushStarted);
        }),
        Router.layerFromModel(model).pipe(Layer.provide(historyLayer)),
      );

      expect(model.reader.getSnapshot()).toEqual({ href: "/" });
      expect(yield* model.reader.journal).toEqual([
        fact(0, RouterEvent.NavigationRequested({ href: "/slow" })),
      ]);
    }),
  );
});
