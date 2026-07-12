import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Decision } from "../src/runtime/decision.ts";
import {
  defineCommand,
  defineEffect,
  defineEvent,
  type EffectRunContext,
} from "../src/runtime/definition.ts";
import { defineFeature } from "../src/runtime/feature.ts";
import { Journal, JournalCommitError, type JournalSnapshot } from "../src/runtime/journal.ts";
import type { Actor, EffectExecution, RenderToken } from "../src/runtime/model.ts";
import { createRuntime, type CabRuntime } from "../src/runtime/runtime.ts";
import { makeRuntimeTestLayers } from "./support/layers.ts";

const actor: Actor = { kind: "agent", id: "agent-7" };

class TestWork extends Context.Service<
  TestWork,
  {
    readonly run: (
      args: { readonly value: string },
      context: EffectRunContext,
    ) => Effect.Effect<string, string, Scope.Scope>;
  }
>()("cab/test/TestWork") {}

const Requested = defineEvent({
  name: "TestRequested",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
  scope: "session",
  retention: "permanent",
  render: ({ value }) => `requested ${value}`,
});
const AlsoRequested = defineEvent({
  name: "TestAlsoRequested",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
  scope: "session",
  retention: "permanent",
  render: ({ value }) => `also requested ${value}`,
});
const WorkCompleted = defineEvent({
  name: "TestWorkCompleted",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
  scope: "session",
  retention: "permanent",
  render: ({ value }) => `completed ${value}`,
});
const WorkFailed = defineEvent({
  name: "TestWorkFailed",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
  scope: "session",
  retention: "permanent",
  render: ({ value }) => `failed ${value}`,
});

const completeWork = defineCommand({
  name: "test.complete",
  description: "Record work success",
  args: Schema.Struct({ value: Schema.String }),
  exposure: "outcome",
  decide: (_context: never, args: { readonly value: string }) =>
    Decision.accept({ events: [WorkCompleted.make(args)] }),
});
const failWork = defineCommand({
  name: "test.fail",
  description: "Record work failure",
  args: Schema.Struct({ value: Schema.String }),
  exposure: "outcome",
  decide: (_context: never, args: { readonly value: string }) =>
    Decision.accept({ events: [WorkFailed.make(args)] }),
});

function workEffect(
  name: string,
  phase: "after-commit" | "after-render",
  concurrency: { readonly _tag: "Every" } | { readonly _tag: "Latest"; readonly key: () => string },
  replay: "never" | "manual" = "never",
) {
  return defineEffect({
    name,
    version: 1,
    description: `Run ${name}`,
    args: Schema.Struct({ value: Schema.String }),
    phase,
    replay,
    authority: "client",
    concurrency,
    run: (args: { readonly value: string }, context) =>
      Effect.gen(function* () {
        const service = yield* TestWork;
        return yield* service.run(args, context);
      }),
    onSuccess: (value: string) => completeWork.make({ value }),
    onFailure: (error: string) => failWork.make({ value: error }),
  });
}

const EveryWork = workEffect("test.every", "after-commit", { _tag: "Every" });
const LatestWork = workEffect("test.latest", "after-commit", {
  _tag: "Latest",
  key: () => "shared",
});
const RenderWork = workEffect("test.render", "after-render", { _tag: "Every" }, "manual");
const LatestRenderWork = workEffect(
  "test.latestRender",
  "after-render",
  { _tag: "Latest", key: () => "shared-render" },
  "manual",
);
const NeverReplayWork = workEffect("test.neverReplay", "after-render", { _tag: "Every" });

function commandFor(name: string, effect: typeof EveryWork) {
  return defineCommand({
    name,
    description: `Dispatch ${effect.name}`,
    args: Schema.Struct({ value: Schema.String }),
    exposure: "public",
    possibleEffects: [effect.name],
    decide: (_context: never, args: { readonly value: string }) =>
      Decision.accept({ events: [Requested.make(args)], effects: [effect.make(args)] }),
  });
}

const runEvery = commandFor("test.runEvery", EveryWork);
const runLatest = commandFor("test.runLatest", LatestWork);
const runRender = commandFor("test.runRender", RenderWork);
const runLatestRender = commandFor("test.runLatestRender", LatestRenderWork);
const runNeverReplay = commandFor("test.runNeverReplay", NeverReplayWork);
const batch = defineCommand({
  name: "test.batch",
  description: "Commit two facts and one effect",
  args: Schema.Struct({ value: Schema.String }),
  exposure: "public",
  possibleEffects: [EveryWork.name],
  decide: (_context: never, args: { readonly value: string }) =>
    Decision.accept({
      events: [Requested.make(args), AlsoRequested.make(args)],
      effects: [EveryWork.make(args)],
    }),
});
const reject = defineCommand({
  name: "test.reject",
  description: "Reject",
  args: Schema.Struct({}),
  exposure: "public",
  decide: () => Decision.reject("test.rejected", "rejected for test"),
});
const noop = defineCommand({
  name: "test.noop",
  description: "No-op",
  args: Schema.Struct({}),
  exposure: "public",
  decide: () => Decision.noop("nothing changed"),
});

type TestState = {
  readonly requested: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly string[];
};

const testFeature = defineFeature<"test", TestState, TestWork>({
  name: "test",
  initialState: { requested: [], completed: [], failed: [] },
  events: [Requested, AlsoRequested, WorkCompleted, WorkFailed],
  commands: [
    runEvery,
    runLatest,
    runRender,
    runLatestRender,
    runNeverReplay,
    batch,
    reject,
    noop,
    completeWork,
    failWork,
  ],
  effects: [EveryWork, LatestWork, RenderWork, LatestRenderWork, NeverReplayWork],
  reduce: (state, fact) => {
    const value = (fact.args as { readonly value: string }).value;
    switch (fact.name) {
      case Requested.name:
      case AlsoRequested.name:
        return { ...state, requested: [...state.requested, value] };
      case WorkCompleted.name:
        return { ...state, completed: [...state.completed, value] };
      case WorkFailed.name:
        return { ...state, failed: [...state.failed, value] };
      default:
        return state;
    }
  },
});

type TestRuntime = CabRuntime<{ readonly test: TestState }>;
type WorkHandler = (
  args: { readonly value: string },
  context: EffectRunContext,
) => Effect.Effect<string, string, Scope.Scope>;

function makeTestRuntime(
  handler: WorkHandler,
  options?: {
    readonly journal?: Layer.Layer<Journal>;
    readonly replayHandler?: WorkHandler;
  },
) {
  const dependencies = makeRuntimeTestLayers();
  const liveService = { run: handler };
  const replayService = { run: options?.replayHandler ?? handler };
  const layer = Layer.merge(
    options?.journal ? Layer.merge(dependencies.layer, options.journal) : dependencies.layer,
    Layer.succeed(TestWork, liveService),
  );

  return Effect.gen(function* () {
    const runtime = yield* createRuntime({
      features: [testFeature] as const,
      rendererId: "renderer-test",
      replayContext: Context.make(TestWork, replayService),
    }).pipe(Effect.provide(layer));
    return { runtime, reports: dependencies.reports };
  });
}

function seededJournalLayer(seed: JournalSnapshot): Layer.Layer<Journal> {
  return Layer.sync(Journal, () => {
    let current = structuredClone(seed);
    return {
      snapshot: Effect.sync(() => current),
      commit: (transaction) =>
        Effect.sync(() => {
          current = {
            ...current,
            facts: [...current.facts, ...structuredClone(transaction.facts)],
            invocations: [...current.invocations, ...structuredClone(transaction.invocations)],
          };
        }),
      recoverClaimed: Effect.sync(() => {
        let recovered = 0;
        current = {
          ...current,
          invocations: current.invocations.map((invocation) => {
            if (invocation.status !== "claimed") return invocation;
            recovered += 1;
            return { ...invocation, status: "pending" as const };
          }),
        };
        return recovered;
      }),
      rebasePendingRenderTokens: (token) =>
        Effect.sync(() => {
          current = {
            ...current,
            invocations: current.invocations.map((invocation) =>
              invocation.status === "pending" && invocation.phase === "after-render"
                ? { ...invocation, renderToken: token }
                : invocation,
            ),
          };
        }),
      claimNextPending: Effect.sync(() => {
        const index = current.invocations.findIndex((item) => item.status === "pending");
        const invocation = current.invocations[index];
        if (!invocation) return undefined;
        const claimed = { ...invocation, status: "claimed" as const };
        current = {
          ...current,
          invocations: current.invocations.map((item, itemIndex) =>
            itemIndex === index ? claimed : item,
          ),
        };
        return claimed;
      }),
      compareAndSetInvocationStatus: (id, expected, status) =>
        Effect.sync(() => {
          const invocation = current.invocations.find((item) => item.id === id);
          if (!invocation || invocation.status !== expected) return false;
          current = {
            ...current,
            invocations: current.invocations.map((item) =>
              item.id === id ? { ...item, status } : item,
            ),
          };
          return true;
        }),
      continueFrom: ({ sequence, nextBranchId, nextBranchEpoch }) =>
        Effect.sync(() => {
          current = {
            facts: current.facts.slice(0, sequence),
            invocations: current.invocations.filter(
              (invocation) => invocation.triggerSequence <= sequence,
            ),
            branchId: nextBranchId,
            branchEpoch: nextBranchEpoch,
          };
          return current;
        }),
    };
  });
}

function forkTerminal(runtime: TestRuntime, effect?: string) {
  return runtime.executionChanges.pipe(
    Stream.filter(
      (execution) =>
        (!effect || execution.effect === effect) &&
        ["succeeded", "failed", "interrupted", "stale", "defect"].includes(execution.status),
    ),
    Stream.runHead,
    Effect.forkChild,
    Effect.tap(() => Effect.yieldNow),
  );
}

function joinExecution(fiber: Fiber.Fiber<Option.Option<EffectExecution>, unknown>) {
  return Fiber.join(fiber).pipe(
    Effect.map((result) => {
      expect(Option.isSome(result)).toBe(true);
      return Option.getOrThrow(result);
    }),
  );
}

describe("runtime dispatch transaction", () => {
  it.effect("commits and publishes a multi-fact batch with its outbox atomically", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const { runtime } = yield* makeTestRuntime((_args) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("done"),
        ),
      );
      const revisions = yield* runtime.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const result = yield* runtime.dispatch(batch.make({ value: "a" }), actor);
      yield* Deferred.await(started);
      const snapshot = yield* runtime.snapshot;
      const published = yield* Fiber.join(revisions);

      expect(result._tag).toBe("Accepted");
      expect(snapshot.journal.map((item) => item.name)).toEqual([
        "TestRequested",
        "TestAlsoRequested",
      ]);
      expect(snapshot.state.test.requested).toEqual(["a", "a"]);
      expect(snapshot.invocations).toHaveLength(1);
      expect(snapshot.invocations[0]).toMatchObject({
        definition: "test.every",
        status: "claimed",
        commitId: snapshot.journal[0]?.commitId,
      });
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ sequence: 2, facts: snapshot.journal });

      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect("drains pending startup work once in journal commit order", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const allStarted = yield* Deferred.make<void>();
      const starts = yield* Ref.make<readonly string[]>([]);
      function makeFact(value: string, sequence: number): JournalSnapshot["facts"][number] {
        return {
          id: `fact-seed-${sequence}`,
          sequence,
          name: Requested.name,
          version: 1,
          args: { value },
          actor,
          commandId: `command-seed-${sequence}`,
          commitId: `commit-seed-${sequence}`,
          correlationId: `command-seed-${sequence}`,
          causationId: `command-seed-${sequence}`,
          branchId: "branch-root",
          branchEpoch: 0,
          at: sequence,
        };
      }
      const facts = [makeFact("first", 1), makeFact("second", 2)];
      const invocations: JournalSnapshot["invocations"] = facts.map((fact) => ({
        id: `${fact.commandId}:0:1`,
        definition: EveryWork.name,
        version: 1,
        args: { value: (fact.args as { readonly value: string }).value },
        ordinal: 0,
        commandId: fact.commandId,
        commitId: fact.commitId,
        correlationId: fact.correlationId,
        actor,
        branchId: "branch-root",
        branchEpoch: 0,
        triggerSequence: fact.sequence,
        phase: "after-commit",
        replay: "never",
        authority: "client",
        status: fact.sequence === 1 ? "claimed" : "pending",
      }));
      const { runtime } = yield* makeTestRuntime(
        ({ value }) =>
          Effect.gen(function* () {
            const values = yield* Ref.updateAndGet(starts, (current) => [...current, value]);
            if (values.length === 2) yield* Deferred.succeed(allStarted, undefined);
            yield* Deferred.await(release);
            return `${value}-done`;
          }),
        {
          journal: seededJournalLayer({
            facts,
            invocations,
            branchId: "branch-root",
            branchEpoch: 0,
          }),
        },
      );

      yield* Deferred.await(allStarted);
      expect(yield* Ref.get(starts)).toEqual(["first", "second"]);
      expect((yield* runtime.snapshot).invocations.map((item) => item.status)).toEqual([
        "claimed",
        "claimed",
      ]);

      yield* runtime.scrub(2);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(starts)).toEqual(["first", "second"]);
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect("rebases recovered after-render work onto the startup render token", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fact: JournalSnapshot["facts"][number] = {
        id: "fact-render-seed",
        sequence: 1,
        name: Requested.name,
        version: 1,
        args: { value: "render-seed" },
        actor,
        commandId: "command-render-seed",
        commitId: "commit-render-seed",
        correlationId: "command-render-seed",
        causationId: "command-render-seed",
        branchId: "branch-root",
        branchEpoch: 0,
        at: 1,
      };
      const { runtime } = yield* makeTestRuntime(
        ({ value }) => Deferred.succeed(started, undefined).pipe(Effect.as(value)),
        {
          journal: seededJournalLayer({
            facts: [fact],
            invocations: [
              {
                id: "command-render-seed:0:1",
                definition: RenderWork.name,
                version: 1,
                args: { value: "render-seed" },
                ordinal: 0,
                commandId: fact.commandId,
                commitId: fact.commitId,
                correlationId: fact.correlationId,
                actor,
                branchId: "branch-root",
                branchEpoch: 0,
                triggerSequence: 1,
                phase: "after-render",
                replay: "manual",
                authority: "client",
                renderToken: {
                  rendererId: "renderer-test",
                  revision: 99,
                  sequence: 1,
                  mode: "live",
                },
                status: "claimed",
              },
            ],
            branchId: "branch-root",
            branchEpoch: 0,
          }),
        },
      );
      const snapshot = yield* runtime.snapshot;

      expect(snapshot.invocations[0]?.renderToken).toEqual(snapshot.renderToken);
      expect(yield* Deferred.isDone(started)).toBe(false);
      yield* runtime.acknowledgeRender(snapshot.renderToken);
      yield* Deferred.await(started);
    }),
  );

  it.effect("keeps rejection, no-op, and invalid arguments isolated from facts and effects", () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const { runtime } = yield* makeTestRuntime(() =>
        Ref.update(starts, (count) => count + 1).pipe(Effect.as("unexpected")),
      );

      const rejected = yield* runtime.dispatch(reject.make({}), actor);
      const noChange = yield* runtime.dispatch(noop.make({}), actor);
      const invalid = yield* runtime.dispatchUnknown("test.runEvery", { value: 4 }, actor);
      const snapshot = yield* runtime.snapshot;

      expect(rejected).toMatchObject({
        _tag: "Rejected",
        rejection: { code: "test.rejected" },
      });
      expect(noChange).toMatchObject({ _tag: "Noop", reason: "nothing changed" });
      expect(invalid).toMatchObject({
        _tag: "Rejected",
        rejection: { code: "runtime.command.invalid-args" },
      });
      expect(snapshot.journal).toEqual([]);
      expect(snapshot.invocations).toEqual([]);
      expect(yield* Ref.get(starts)).toBe(0);
    }),
  );

  it.effect("rejects public access to outcomes and exposes only public command schemas", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeTestRuntime(({ value }) => Effect.succeed(value));

      const forbidden = yield* runtime.dispatch(completeWork.make({ value: "forged" }), actor);
      const unknown = yield* runtime.dispatchUnknown("test.missing", {}, actor);
      const description = yield* runtime.describe;

      expect(forbidden).toMatchObject({
        _tag: "Rejected",
        rejection: { code: "runtime.command.forbidden" },
      });
      expect(unknown).toMatchObject({
        _tag: "Rejected",
        rejection: { code: "runtime.command.unknown" },
      });
      expect(description.commands.map((item) => item.name)).not.toContain("test.complete");
      expect(description.commands.find((item) => item.name === "test.runEvery")).toMatchObject({
        possibleEffects: [{ name: "test.every", phase: "after-commit", replay: "never" }],
      });
      expect(
        Object.keys(
          description.commands.find((item) => item.name === "test.runEvery")?.argsSchema ?? {},
        ).length,
      ).toBeGreaterThan(0);
    }),
  );

  it.effect("does not append partial facts or invocations when journal commit fails", () =>
    Effect.gen(function* () {
      const empty: JournalSnapshot = {
        facts: [],
        invocations: [],
        branchId: "branch-root",
        branchEpoch: 0,
      };
      const starts = yield* Ref.make(0);
      const failingJournal = Layer.succeed(Journal, {
        snapshot: Effect.succeed(empty),
        commit: () =>
          Effect.fail(new JournalCommitError({ code: "stale-head", message: "injected" })),
        recoverClaimed: Effect.succeed(0),
        rebasePendingRenderTokens: () => Effect.void,
        claimNextPending: Effect.succeed(undefined),
        compareAndSetInvocationStatus: () => Effect.succeed(false),
        continueFrom: () => Effect.succeed(empty),
      });
      const { runtime } = yield* makeTestRuntime(
        () => Ref.update(starts, (count) => count + 1).pipe(Effect.as("unexpected")),
        { journal: failingJournal },
      );

      const exit = yield* Effect.exit(runtime.dispatch(batch.make({ value: "a" }), actor));
      const snapshot = yield* runtime.snapshot;

      expect(Exit.isFailure(exit)).toBe(true);
      expect(snapshot.journal).toEqual([]);
      expect(snapshot.invocations).toEqual([]);
      expect(yield* Ref.get(starts)).toBe(0);
    }),
  );

  it.effect(
    "uses stable IDs independent of sequence and advances branch epochs on continuation",
    () =>
      Effect.gen(function* () {
        const { runtime } = yield* makeTestRuntime(({ value }) => Effect.succeed(value));
        const firstTerminal = yield* forkTerminal(runtime, EveryWork.name);
        const first = yield* runtime.dispatch(batch.make({ value: "first" }), actor);
        yield* joinExecution(firstTerminal);
        const before = yield* runtime.snapshot;

        yield* runtime.scrub(0);
        yield* runtime.continueFrom();
        const afterContinuation = yield* runtime.snapshot;
        const secondTerminal = yield* forkTerminal(runtime, EveryWork.name);
        const second = yield* runtime.dispatch(batch.make({ value: "second" }), actor);
        yield* joinExecution(secondTerminal);

        expect(first._tag).toBe("Accepted");
        expect(second._tag).toBe("Accepted");
        if (first._tag === "Accepted" && second._tag === "Accepted") {
          expect(new Set(first.facts.map((item) => item.id)).size).toBe(2);
          expect(first.facts[0]?.commitId).toBe(first.facts[1]?.commitId);
          expect(first.effectInvocationIds[0]).toBe(`${first.command.id}:0:1`);
          expect(second.facts[0]?.sequence).toBe(1);
          expect(second.facts[0]?.id).not.toBe(first.facts[0]?.id);
          expect(second.commit.branchId).not.toBe(first.commit.branchId);
          expect(second.commit.branchEpoch).toBe(first.commit.branchEpoch + 1);
        }
        expect(before.branchEpoch).toBe(0);
        expect(afterContinuation).toMatchObject({ branchEpoch: 1, sequence: 0 });
      }),
  );
});

describe("effect execution", () => {
  it.effect("starts only after commit and maps success with actor and causation metadata", () =>
    Effect.gen(function* () {
      let runtime!: TestRuntime;
      const observed = yield* Deferred.make<{
        readonly facts: number;
        readonly requested: readonly string[];
      }>();
      const built = yield* makeTestRuntime(({ value }) =>
        Effect.gen(function* () {
          const snapshot = yield* runtime.snapshot;
          yield* Deferred.succeed(observed, {
            facts: snapshot.journal.length,
            requested: snapshot.state.test.requested,
          });
          return `${value}-done`;
        }),
      );
      runtime = built.runtime;
      const terminal = yield* forkTerminal(runtime, EveryWork.name);

      const accepted = yield* runtime.dispatch(runEvery.make({ value: "work" }), actor);
      expect(yield* Deferred.await(observed)).toEqual({ facts: 1, requested: ["work"] });
      expect((yield* joinExecution(terminal)).status).toBe("succeeded");
      const snapshot = yield* runtime.snapshot;

      expect(snapshot.journal.map((item) => item.name)).toEqual([
        "TestRequested",
        "TestWorkCompleted",
      ]);
      const outcome = snapshot.journal[1];
      expect(outcome?.actor).toEqual(actor);
      expect(outcome?.correlationId).toBe(accepted.command.correlationId);
      expect(outcome?.causationId).toBe(accepted.effectInvocationIds[0]);
      expect(outcome?.commandId).not.toBe(accepted.command.id);
    }),
  );

  it.effect("maps typed failures but supervises defects without fabricating facts", () =>
    Effect.gen(function* () {
      const failing = yield* makeTestRuntime(() => Effect.fail("offline"));
      const failedTerminal = yield* forkTerminal(failing.runtime, EveryWork.name);
      yield* failing.runtime.dispatch(runEvery.make({ value: "work" }), actor);
      expect((yield* joinExecution(failedTerminal)).status).toBe("failed");
      expect((yield* failing.runtime.snapshot).journal.map((item) => item.name)).toEqual([
        "TestRequested",
        "TestWorkFailed",
      ]);

      const defective = yield* makeTestRuntime(() => Effect.die(new Error("boom")));
      const defectTerminal = yield* forkTerminal(defective.runtime, EveryWork.name);
      yield* defective.runtime.dispatch(runEvery.make({ value: "work" }), actor);
      expect((yield* joinExecution(defectTerminal)).status).toBe("defect");
      expect((yield* defective.runtime.snapshot).journal.map((item) => item.name)).toEqual([
        "TestRequested",
      ]);
      expect(yield* defective.reports).toHaveLength(1);
    }),
  );

  it.effect("waits for the exact render acknowledgement", () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const { runtime } = yield* makeTestRuntime(({ value }) =>
        Ref.update(starts, (count) => count + 1).pipe(Effect.as(value)),
      );
      const terminal = yield* forkTerminal(runtime, RenderWork.name);
      const accepted = yield* runtime.dispatch(runRender.make({ value: "rendered" }), actor);
      const snapshot = yield* runtime.snapshot;
      const wrong: RenderToken = {
        ...snapshot.renderToken,
        revision: snapshot.renderToken.revision - 1,
      };

      yield* runtime.acknowledgeRender(wrong);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(starts)).toBe(0);

      yield* runtime.acknowledgeRender(snapshot.renderToken);
      expect((yield* joinExecution(terminal)).status).toBe("succeeded");
      expect(yield* Ref.get(starts)).toBe(1);
      expect(accepted._tag).toBe("Accepted");
    }),
  );

  it.effect("interrupts keyed Latest work, runs finalizers, and suppresses failure outcomes", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();
      const staleObserved = yield* Ref.make(false);
      const never = yield* Deferred.make<string>();
      const { runtime } = yield* makeTestRuntime(({ value }, context) =>
        value === "first"
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.ensuring(
                Effect.gen(function* () {
                  const lease = yield* Effect.exit(context.ensureCurrent);
                  yield* Ref.set(staleObserved, Exit.isFailure(lease));
                  yield* Deferred.succeed(finalized, undefined);
                }),
              ),
            )
          : Effect.succeed("second-done"),
      );

      yield* runtime.dispatch(runLatest.make({ value: "first" }), actor);
      yield* Deferred.await(firstStarted);
      const succeeded = yield* runtime.executionChanges.pipe(
        Stream.filter(
          (execution) => execution.effect === LatestWork.name && execution.status === "succeeded",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* runtime.dispatch(runLatest.make({ value: "second" }), actor);

      yield* Deferred.await(finalized);
      expect(yield* Ref.get(staleObserved)).toBe(true);
      yield* Effect.yieldNow;
      const executions = yield* runtime.executions;
      expect(executions.find((item) => item.args.value === "first")?.status).toBe("interrupted");
      expect((yield* joinExecution(succeeded)).status).toBe("succeeded");
      const names = (yield* runtime.snapshot).journal.map((item) => item.name);
      expect(names.filter((name) => name === WorkCompleted.name)).toHaveLength(1);
      expect(names).not.toContain(WorkFailed.name);
    }),
  );

  it.effect("orders a racing Latest outcome check and superseding commit atomically", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const { runtime } = yield* makeTestRuntime(({ value }) =>
        value === "first"
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.as("first-done"),
            )
          : Effect.succeed("second-done"),
      );

      yield* runtime.dispatch(runLatest.make({ value: "first" }), actor);
      yield* Deferred.await(firstStarted);
      const second = yield* Effect.forkChild(
        runtime.dispatch(runLatest.make({ value: "second" }), actor),
      );
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(second);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const facts = (yield* runtime.snapshot).journal;
      const secondRequest = facts.findIndex(
        (fact) =>
          fact.name === Requested.name &&
          (fact.args as { readonly value: string }).value === "second",
      );
      const firstOutcome = facts.findIndex(
        (fact) =>
          fact.name === WorkCompleted.name &&
          (fact.args as { readonly value: string }).value === "first-done",
      );
      expect(secondRequest).toBeGreaterThan(0);
      expect(firstOutcome === -1 || firstOutcome < secondRequest).toBe(true);
    }),
  );

  it.effect("does not hold the dispatch lock while a Latest finalizer is interrupted", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const finalizerStarted = yield* Deferred.make<void>();
      const releaseFinalizer = yield* Deferred.make<void>();
      const never = yield* Deferred.make<string>();
      const { runtime } = yield* makeTestRuntime(({ value }) =>
        value === "first"
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.ensuring(
                Deferred.succeed(finalizerStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFinalizer)),
                ),
              ),
            )
          : Effect.succeed("second-done"),
      );

      yield* runtime.dispatch(runLatest.make({ value: "first" }), actor);
      yield* Deferred.await(firstStarted);
      const second = yield* runtime.dispatch(runLatest.make({ value: "second" }), actor);
      yield* Deferred.await(finalizerStarted);
      const concurrent = yield* runtime.dispatch(batch.make({ value: "not-blocked" }), actor);

      expect(second._tag).toBe("Accepted");
      expect(concurrent._tag).toBe("Accepted");
      yield* Deferred.succeed(releaseFinalizer, undefined);
    }),
  );

  it.effect("closes an execution acquireRelease Scope when Latest work is interrupted", () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const never = yield* Deferred.make<string>();
      const { runtime } = yield* makeTestRuntime(({ value }) =>
        value === "first"
          ? Effect.acquireRelease(Deferred.succeed(acquired, undefined), () =>
              Deferred.succeed(released, undefined),
            ).pipe(Effect.andThen(Deferred.await(never)))
          : Effect.succeed("second-done"),
      );

      yield* runtime.dispatch(runLatest.make({ value: "first" }), actor);
      yield* Deferred.await(acquired);
      yield* runtime.dispatch(runLatest.make({ value: "second" }), actor);
      yield* Deferred.await(released);

      expect(yield* Deferred.isDone(released)).toBe(true);
    }),
  );

  it.effect("freezes a historical view while an outcome appends to the live head", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const { runtime } = yield* makeTestRuntime(({ value }) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(`${value}-done`),
        ),
      );
      const terminal = yield* forkTerminal(runtime, EveryWork.name);
      yield* runtime.dispatch(runEvery.make({ value: "late" }), actor);
      yield* Deferred.await(started);
      yield* runtime.scrub(0);
      yield* Deferred.succeed(release, undefined);
      yield* joinExecution(terminal);

      const snapshot = yield* runtime.snapshot;
      expect(snapshot).toMatchObject({ mode: "historical", sequence: 0, headSequence: 2 });
      expect(snapshot.state.test).toEqual(testFeature.initialState);
      expect(snapshot.liveState.test.completed).toEqual(["late-done"]);
      expect((yield* runtime.stateAt(2)).state.test.completed).toEqual(["late-done"]);
    }),
  );

  it.effect(
    "interrupts removed branch work and withholds publication until its finalizer completes",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finalizerStarted = yield* Deferred.make<void>();
        const releaseFinalizer = yield* Deferred.make<void>();
        const never = yield* Deferred.make<string>();
        const { runtime } = yield* makeTestRuntime(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(never)),
            Effect.ensuring(
              Deferred.succeed(finalizerStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFinalizer)),
              ),
            ),
          ),
        );

        yield* runtime.dispatch(runEvery.make({ value: "removed" }), actor);
        yield* Deferred.await(started);
        yield* runtime.scrub(0);
        const publication = yield* Deferred.make<void>();
        yield* runtime.changes.pipe(
          Stream.runHead,
          Effect.andThen(Deferred.succeed(publication, undefined)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const continuation = yield* Effect.forkChild(runtime.continueFrom());
        yield* Deferred.await(finalizerStarted);
        expect(yield* Deferred.isDone(publication)).toBe(false);
        const whileFinalizing = yield* runtime.dispatch(noop.make({}), actor);
        expect(whileFinalizing).toMatchObject({
          _tag: "Rejected",
          rejection: { code: "runtime.branch.continuing" },
        });
        yield* Deferred.succeed(releaseFinalizer, undefined);
        yield* Fiber.join(continuation);
        yield* Deferred.await(publication);
        const snapshot = yield* runtime.snapshot;

        expect(yield* Deferred.isDone(finalizerStarted)).toBe(true);
        expect(snapshot).toMatchObject({ branchEpoch: 1, sequence: 0, headSequence: 0 });
        expect(snapshot.invocations).toEqual([]);
        expect(snapshot.journal).toEqual([]);
      }),
  );

  it.effect("rebases retained work so its outcome commits on the continued branch", () =>
    Effect.gen(function* () {
      const retainedStarted = yield* Deferred.make<void>();
      const removedStarted = yield* Deferred.make<void>();
      const releaseRetained = yield* Deferred.make<void>();
      const finalizerStarted = yield* Deferred.make<void>();
      const releaseFinalizer = yield* Deferred.make<void>();
      const never = yield* Deferred.make<string>();
      const { runtime } = yield* makeTestRuntime(({ value }) =>
        value === "retained"
          ? Deferred.succeed(retainedStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRetained)),
              Effect.as("retained-done"),
            )
          : Deferred.succeed(removedStarted, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.ensuring(
                Deferred.succeed(finalizerStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFinalizer)),
                ),
              ),
            ),
      );

      yield* runtime.dispatch(runEvery.make({ value: "retained" }), actor);
      yield* Deferred.await(retainedStarted);
      yield* runtime.dispatch(runEvery.make({ value: "removed" }), actor);
      yield* Deferred.await(removedStarted);
      yield* runtime.scrub(1);
      const retainedTerminal = yield* runtime.executionChanges.pipe(
        Stream.filter(
          (execution) =>
            (execution.args as { readonly value: string }).value === "retained" &&
            execution.status === "succeeded",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const continuation = yield* Effect.forkChild(runtime.continueFrom());
      yield* Deferred.await(finalizerStarted);
      yield* Deferred.succeed(releaseRetained, undefined);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFinalizer, undefined);
      yield* Fiber.join(continuation);
      yield* joinExecution(retainedTerminal);

      const snapshot = yield* runtime.snapshot;
      expect(snapshot.journal.map((fact) => fact.name)).toEqual([
        Requested.name,
        WorkCompleted.name,
      ]);
      expect(snapshot.journal[1]).toMatchObject({
        sequence: 2,
        branchEpoch: 1,
        args: { value: "retained-done" },
      });
    }),
  );

  it.effect("interrupts all owned work and runs finalizers when the runtime Scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();
      const never = yield* Deferred.make<string>();
      const scope = yield* Scope.make();
      const dependencies = makeRuntimeTestLayers();
      const runtime = yield* createRuntime({ features: [testFeature] as const }).pipe(
        Effect.provideService(TestWork, {
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
        }),
        Effect.provide(dependencies.layer),
        Effect.provideService(Scope.Scope, scope),
      );

      yield* runtime.dispatch(runEvery.make({ value: "scoped" }), actor);
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(finalized);

      const closed = yield* Effect.exit(runtime.dispatch(noop.make({}), actor));
      expect(Exit.isFailure(closed)).toBe(true);
      if (Exit.isFailure(closed)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(closed.cause))).toMatchObject({
          _tag: "RuntimeClosedError",
        });
      }
    }),
  );
});

describe("manual replay", () => {
  it.effect("requires consent and an acknowledged selected render", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeTestRuntime(({ value }) => Effect.succeed(value));
      const liveTerminal = yield* forkTerminal(runtime, RenderWork.name);
      const accepted = yield* runtime.dispatch(runRender.make({ value: "visible" }), actor);
      const live = yield* runtime.snapshot;
      yield* runtime.acknowledgeRender(live.renderToken);
      yield* joinExecution(liveTerminal);
      const invocationId = accepted._tag === "Accepted" ? accepted.effectInvocationIds[0]! : "";

      const noConsent = yield* Effect.exit(
        runtime.replayEffect({ invocationId, rendererId: "renderer-test", allow: false }),
      );
      expect(Exit.isFailure(noConsent)).toBe(true);

      yield* runtime.scrub(1);
      const historical = yield* runtime.snapshot;
      const unacknowledged = yield* Effect.exit(
        runtime.replayEffect({ invocationId, rendererId: "renderer-test", allow: true }),
      );
      expect(Exit.isFailure(unacknowledged)).toBe(true);
      yield* runtime.acknowledgeRender(historical.renderToken);
    }),
  );

  it.effect("replays only manual invocations and suppresses replay outcomes", () =>
    Effect.gen(function* () {
      const modes = yield* Ref.make<readonly string[]>([]);
      const { runtime } = yield* makeTestRuntime(({ value }, context) =>
        Ref.update(modes, (values) => [...values, context.mode]).pipe(Effect.as(value)),
      );
      const liveTerminal = yield* forkTerminal(runtime, RenderWork.name);
      const accepted = yield* runtime.dispatch(runRender.make({ value: "visible" }), actor);
      let snapshot = yield* runtime.snapshot;
      yield* runtime.acknowledgeRender(snapshot.renderToken);
      yield* joinExecution(liveTerminal);
      yield* runtime.dispatch(noop.make({}), actor);
      yield* runtime.scrub(1);
      snapshot = yield* runtime.snapshot;
      yield* runtime.acknowledgeRender(snapshot.renderToken);
      const replayTerminal = yield* forkTerminal(runtime, RenderWork.name);
      const invocationId = accepted._tag === "Accepted" ? accepted.effectInvocationIds[0]! : "";

      const replay = yield* runtime.replayEffect({
        invocationId,
        rendererId: "renderer-test",
        allow: true,
      });
      expect((yield* joinExecution(replayTerminal)).status).toBe("succeeded");
      expect(replay.invocationId).toBe(invocationId);
      expect(yield* Ref.get(modes)).toEqual(["live", "manual-replay"]);
      expect((yield* runtime.snapshot).journal.map((item) => item.name)).toEqual([
        "TestRequested",
        "TestWorkCompleted",
      ]);
    }),
  );

  it.effect(
    "replays an older selected Latest invocation without superseding live Latest work",
    () =>
      Effect.gen(function* () {
        const latestStarted = yield* Deferred.make<void>();
        const releaseLatest = yield* Deferred.make<void>();
        const latestFinalized = yield* Deferred.make<void>();
        const replayStarted = yield* Deferred.make<void>();
        const releaseReplay = yield* Deferred.make<void>();
        const { runtime } = yield* makeTestRuntime(
          ({ value }) =>
            value === "latest"
              ? Deferred.succeed(latestStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseLatest)),
                  Effect.as("latest-done"),
                  Effect.ensuring(Deferred.succeed(latestFinalized, undefined)),
                )
              : Effect.succeed(`${value}-done`),
          {
            replayHandler: ({ value }) =>
              Deferred.succeed(replayStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseReplay)),
                Effect.as(`${value}-replayed`),
              ),
          },
        );

        const olderTerminal = yield* forkTerminal(runtime, LatestRenderWork.name);
        const older = yield* runtime.dispatch(runLatestRender.make({ value: "older" }), actor);
        let snapshot = yield* runtime.snapshot;
        yield* runtime.acknowledgeRender(snapshot.renderToken);
        expect((yield* joinExecution(olderTerminal)).status).toBe("succeeded");

        const latestTerminal = yield* forkTerminal(runtime, LatestRenderWork.name);
        yield* runtime.dispatch(runLatestRender.make({ value: "latest" }), actor);
        snapshot = yield* runtime.snapshot;
        yield* runtime.acknowledgeRender(snapshot.renderToken);
        yield* Deferred.await(latestStarted);

        yield* runtime.scrub(2);
        snapshot = yield* runtime.snapshot;
        yield* runtime.acknowledgeRender(snapshot.renderToken);
        const replayTerminal = yield* forkTerminal(runtime, LatestRenderWork.name);
        const invocationId = older._tag === "Accepted" ? older.effectInvocationIds[0]! : "";
        yield* runtime.replayEffect({
          invocationId,
          rendererId: "renderer-test",
          allow: true,
        });

        yield* Deferred.await(replayStarted);
        expect(yield* Deferred.isDone(latestFinalized)).toBe(false);
        yield* Deferred.succeed(releaseReplay, undefined);
        expect((yield* joinExecution(replayTerminal)).status).toBe("succeeded");

        yield* Deferred.succeed(releaseLatest, undefined);
        expect((yield* joinExecution(latestTerminal)).status).toBe("succeeded");
        yield* Deferred.await(latestFinalized);
        expect((yield* runtime.snapshot).liveState.test.completed).toContain("latest-done");
      }),
  );

  it.effect(
    "interrupts a running replay and runs its finalizer when the render is superseded",
    () =>
      Effect.gen(function* () {
        const replayStarted = yield* Deferred.make<void>();
        const replayFinalized = yield* Deferred.make<void>();
        const staleObserved = yield* Ref.make(false);
        const never = yield* Deferred.make<string>();
        const { runtime } = yield* makeTestRuntime(({ value }) => Effect.succeed(value), {
          replayHandler: (_args, context) =>
            Deferred.succeed(replayStarted, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.ensuring(
                Effect.gen(function* () {
                  const lease = yield* Effect.exit(context.ensureCurrent);
                  yield* Ref.set(staleObserved, Exit.isFailure(lease));
                  yield* Deferred.succeed(replayFinalized, undefined);
                }),
              ),
            ),
        });

        const liveTerminal = yield* forkTerminal(runtime, LatestRenderWork.name);
        const accepted = yield* runtime.dispatch(runLatestRender.make({ value: "visible" }), actor);
        let snapshot = yield* runtime.snapshot;
        yield* runtime.acknowledgeRender(snapshot.renderToken);
        expect((yield* joinExecution(liveTerminal)).status).toBe("succeeded");

        yield* runtime.scrub(1);
        snapshot = yield* runtime.snapshot;
        yield* runtime.acknowledgeRender(snapshot.renderToken);
        const replayTerminal = yield* forkTerminal(runtime, LatestRenderWork.name);
        const invocationId = accepted._tag === "Accepted" ? accepted.effectInvocationIds[0]! : "";
        yield* runtime.replayEffect({
          invocationId,
          rendererId: "renderer-test",
          allow: true,
        });
        yield* Deferred.await(replayStarted);

        yield* runtime.live;
        yield* Deferred.await(replayFinalized);
        expect(yield* Ref.get(staleObserved)).toBe(true);
        expect((yield* joinExecution(replayTerminal)).status).toBe("interrupted");
      }),
  );

  it.effect("rejects replay for definitions whose policy is never", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeTestRuntime(({ value }) => Effect.succeed(value));
      const accepted = yield* runtime.dispatch(runNeverReplay.make({ value: "never" }), actor);
      const snapshot = yield* runtime.snapshot;
      yield* runtime.acknowledgeRender(snapshot.renderToken);
      const invocationId = accepted._tag === "Accepted" ? accepted.effectInvocationIds[0]! : "";
      const replay = yield* Effect.exit(
        runtime.replayEffect({ invocationId, rendererId: "renderer-test", allow: true }),
      );

      expect(Exit.isFailure(replay)).toBe(true);
      if (Exit.isFailure(replay)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(replay.cause))).toMatchObject({
          code: "replay-forbidden",
        });
      }
    }),
  );
});
