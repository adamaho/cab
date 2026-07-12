import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect";
import {
  FetchTodos,
  completeTodosRefresh,
  failTodosRefresh,
} from "../src/features/ingest/feature.ts";
import { ScrollToTodo } from "../src/features/todos/feature.ts";
import { StaleExecution, type EffectRunContext } from "../src/runtime/definition.ts";
import {
  CacheError,
  TodoApi,
  TodoApiError,
  TodoCache,
  Viewport,
  type TodoRecord,
} from "../src/runtime/services.ts";

const actor = { kind: "agent", id: "test-agent" } as const;
const todos: readonly TodoRecord[] = [
  { id: 1, title: "One", completed: false },
  { id: 2, title: "Two", completed: true },
];

function context(
  mode: "live" | "manual-replay" = "live",
  ensureCurrent: Effect.Effect<void, StaleExecution> = Effect.void,
): EffectRunContext {
  return {
    executionId: "execution-1",
    invocationId: "invocation-1",
    commandId: "command-1",
    commitId: "commit-1",
    correlationId: "correlation-1",
    actor,
    mode,
    attempt: 1,
    ensureCurrent,
  };
}

describe("todo fetch effect", () => {
  it.effect("uses test Layers and maps success to the typed outcome command", () =>
    Effect.gen(function* () {
      const values = new Map<string, readonly TodoRecord[]>();
      const layer = Layer.mergeAll(
        Layer.succeed(TodoApi, { list: () => Effect.succeed(todos) }),
        Layer.succeed(TodoCache, {
          put: (value) =>
            Effect.sync(() => {
              values.set("hash-1", structuredClone(value));
              return "hash-1";
            }),
          get: (hash) => Effect.succeed(Option.fromNullishOr(values.get(hash))),
        }),
      );

      const result = yield* FetchTodos.run({ requestId: "request-1" }, context()).pipe(
        Effect.provide(layer),
      );
      const outcome = FetchTodos.onSuccess?.(result, { requestId: "request-1" }, context());

      expect(values.get("hash-1")).toEqual(todos);
      expect(outcome).toEqual(
        completeTodosRefresh.make({ requestId: "request-1", requestHash: "hash-1", count: 2 }),
      );
    }),
  );

  it.effect("preserves an expected API failure and maps it to the failure outcome", () =>
    Effect.gen(function* () {
      const error = new TodoApiError({ message: "offline" });
      const layer = Layer.mergeAll(
        Layer.succeed(TodoApi, { list: () => Effect.fail(error) }),
        Layer.succeed(TodoCache, {
          put: () => Effect.fail(new CacheError({ message: "unused" })),
          get: () => Effect.succeed(Option.none()),
        }),
      );

      const exit = yield* Effect.exit(
        FetchTodos.run({ requestId: "request-2" }, context()).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.getOrUndefined(failure)).toBe(error);
        expect(FetchTodos.onFailure?.(error, { requestId: "request-2" }, context())).toEqual(
          failTodosRefresh.make({ requestId: "request-2", message: "offline" }),
        );
      }
    }),
  );

  it.effect("checks its lease before publishing staged cache data", () =>
    Effect.gen(function* () {
      const puts = yield* Ref.make(0);
      const stale = new StaleExecution("abandoned branch");
      const layer = Layer.mergeAll(
        Layer.succeed(TodoApi, { list: () => Effect.succeed(todos) }),
        Layer.succeed(TodoCache, {
          put: () => Ref.updateAndGet(puts, (count) => count + 1).pipe(Effect.as("hash")),
          get: () => Effect.succeed(Option.none()),
        }),
      );

      const exit = yield* Effect.exit(
        FetchTodos.run({ requestId: "request-3" }, context("live", Effect.fail(stale))).pipe(
          Effect.provide(layer),
        ),
      );

      expect(yield* Ref.get(puts)).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(stale);
      }
    }),
  );
});

describe("viewport effect", () => {
  it.effect("uses the viewport service with smooth live and auto replay behavior", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<readonly unknown[]>([]);
      const layer = Layer.succeed(Viewport, {
        scrollTo: (anchor, options) =>
          Ref.update(calls, (current) => [...current, { anchor, options }]),
      });

      yield* ScrollToTodo.run({ id: 7 }, context("live")).pipe(Effect.provide(layer));
      yield* ScrollToTodo.run({ id: 7 }, context("manual-replay")).pipe(Effect.provide(layer));

      expect(yield* Ref.get(calls)).toEqual([
        {
          anchor: "#todo-7",
          options: { behavior: "smooth", block: "center" },
        },
        {
          anchor: "#todo-7",
          options: { behavior: "auto", block: "center" },
        },
      ]);
    }),
  );

  it.effect("does not read browser globals when a deterministic viewport Layer is supplied", () =>
    Effect.gen(function* () {
      const previousFetch = globalThis.fetch;
      const previousDocument = globalThis.document;
      let calls = 0;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: () => {
          throw new Error("global fetch used");
        },
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          querySelector: () => {
            throw new Error("global document used");
          },
        },
      });

      yield* ScrollToTodo.run({ id: 9 }, context()).pipe(
        Effect.provide(
          Layer.succeed(Viewport, {
            scrollTo: () => Effect.sync(() => void (calls += 1)),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            Object.defineProperty(globalThis, "fetch", {
              configurable: true,
              value: previousFetch,
            });
            Object.defineProperty(globalThis, "document", {
              configurable: true,
              value: previousDocument,
            });
          }),
        ),
      );

      expect(calls).toBe(1);
    }),
  );
});
