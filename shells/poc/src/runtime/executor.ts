import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Option,
  PubSub,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  effectConcurrencyKey,
  StaleExecution,
  type CommandInvocation,
  type EffectDefinition,
  type EffectRunContext,
} from "./definition.ts";
import { cloneSerializable, type FeatureRegistry } from "./feature.ts";
import type { CommittedEffectInvocation, EffectExecution, RenderToken } from "./model.ts";
import { RenderBarrierError, type SupervisorReport } from "./services.ts";

/** Reports why an explicit effect replay was refused. @category errors @since 0.0.0 */
export class ReplayRejected extends Data.TaggedError("ReplayRejected")<{
  readonly code:
    | "consent-required"
    | "unknown-invocation"
    | "not-visible"
    | "replay-forbidden"
    | "version-mismatch"
    | "render-not-acknowledged";
  readonly message: string;
}> {}

/** Requests explicit, invocation-based presentation replay. @category replay @since 0.0.0 */
export interface ReplayRequest {
  readonly invocation: CommittedEffectInvocation;
  readonly renderToken: RenderToken;
  readonly allow: boolean;
}

/** Reports a scheduled replay execution identity. @category replay @since 0.0.0 */
export interface ReplayResult {
  readonly executionId: string;
  readonly invocationId: string;
}

interface OutcomeDispatchResult {
  readonly _tag: "Accepted" | "Rejected" | "Noop";
}

/** Configures the scoped executor without exposing its mutable internals. @category effects @since 0.0.0 */
export interface EffectExecutorConfig {
  readonly registry: FeatureRegistry;
  readonly effectContext: Context.Context<never>;
  readonly replayContext: Context.Context<never>;
  readonly nextId: (kind: string) => Effect.Effect<string>;
  readonly now: Effect.Effect<number>;
  readonly branchEpoch: () => number;
  readonly isInvocationCurrent: (invocationId: string, concurrencyKey?: string) => boolean;
  readonly compareAndSetInvocationStatus: (
    invocationId: string,
    expected: CommittedEffectInvocation["status"],
    status: CommittedEffectInvocation["status"],
  ) => Effect.Effect<boolean, unknown>;
  readonly awaitRender: (token: RenderToken) => Effect.Effect<void, RenderBarrierError>;
  readonly isRenderAcknowledged: (token: RenderToken) => Effect.Effect<boolean>;
  readonly dispatchOutcome: (
    invocation: CommandInvocation<string, unknown>,
    execution: EffectExecution,
  ) => Effect.Effect<OutcomeDispatchResult, unknown>;
  readonly supervise: (report: SupervisorReport) => Effect.Effect<void>;
}

/** Owns all live and replay Fibers, leases, and execution telemetry. @category effects @since 0.0.0 */
export interface EffectExecutor {
  readonly submit: (invocation: CommittedEffectInvocation) => Effect.Effect<string>;
  readonly replay: (request: ReplayRequest) => Effect.Effect<ReplayResult, ReplayRejected>;
  readonly fenceInvocations: (
    removedInvocationIds: ReadonlySet<string>,
  ) => Effect.Effect<readonly Fiber.Fiber<void, never>[]>;
  readonly rebaseInvocations: (
    retainedInvocationIds: ReadonlySet<string>,
    branchEpoch: number,
  ) => Effect.Effect<void>;
  readonly supersedeRender: (token: RenderToken) => Effect.Effect<void>;
  readonly isCurrent: (executionId: string) => boolean;
  readonly executions: Effect.Effect<readonly EffectExecution[]>;
  readonly changes: Stream.Stream<EffectExecution>;
}

type ErasedEffect = EffectDefinition<string, unknown, unknown, unknown, unknown>;

interface Lease {
  readonly executionId: string;
  readonly invocationId: string;
  readonly mode: "live" | "manual-replay";
  branchEpoch: number;
  readonly generation: number;
  readonly concurrencyKey?: string;
  renderToken?: RenderToken;
  awaitingRender: boolean;
  active: boolean;
}

interface LatestOwner {
  readonly executionId: string;
  readonly generation: number;
}

function effectProgram(
  definition: ErasedEffect,
  args: unknown,
  context: EffectRunContext,
): Effect.Effect<unknown, unknown> {
  return definition.run(args, context) as Effect.Effect<unknown, unknown>;
}

/** Constructs an executor whose Fibers are bounded by the caller's Scope. @category effects @since 0.0.0 */
export function makeEffectExecutor(
  config: EffectExecutorConfig,
): Effect.Effect<EffectExecutor, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const liveContext = Context.omit(Scope.Scope)(config.effectContext);
    const manualReplayContext = Context.omit(Scope.Scope)(config.replayContext);
    const everyFibers = yield* FiberSet.make<void, never>();
    const liveLatestFibers = yield* FiberMap.make<string, void, never>();
    const replayLatestFibers = yield* FiberMap.make<string, void, never>();
    const telemetryPubSub = yield* PubSub.unbounded<EffectExecution>();
    const leases = new Map<string, Lease>();
    const liveLatestByKey = new Map<string, LatestOwner>();
    const replayLatestByKey = new Map<string, LatestOwner>();
    const runningFibers = new Map<string, Fiber.Fiber<void, never>>();
    const invocationExecutions = new Map<string, Set<string>>();
    const everyLimits = new Map<string, Semaphore.Semaphore>();
    let telemetry: readonly EffectExecution[] = [];

    function current(lease: Lease): boolean {
      const latestOwner = lease.mode === "manual-replay" ? replayLatestByKey : liveLatestByKey;
      const owner =
        lease.concurrencyKey === undefined ? undefined : latestOwner.get(lease.concurrencyKey);
      return (
        lease.active &&
        lease.branchEpoch === config.branchEpoch() &&
        (lease.mode === "manual-replay" ||
          config.isInvocationCurrent(lease.invocationId, lease.concurrencyKey)) &&
        (lease.concurrencyKey === undefined ||
          (owner?.executionId === lease.executionId && owner.generation === lease.generation))
      );
    }

    function update(executionId: string, patch: Partial<EffectExecution>) {
      return Effect.gen(function* () {
        let updated: EffectExecution | undefined;
        telemetry = cloneSerializable(
          telemetry.map((item) => {
            if (item.id !== executionId) return item;
            updated = cloneSerializable({ ...item, ...patch });
            return updated;
          }),
        );
        if (updated) yield* PubSub.publish(telemetryPubSub, updated);
      });
    }

    function end(execution: EffectExecution, status: EffectExecution["status"], detail?: string) {
      return Effect.gen(function* () {
        const endedAt = yield* config.now;
        const lease = leases.get(execution.id);
        if (lease) lease.active = false;
        if (execution.mode === "live") {
          yield* Effect.ignore(
            config.compareAndSetInvocationStatus(execution.invocationId, "claimed", "terminal"),
          );
        }
        yield* update(
          execution.id,
          detail === undefined ? { status, endedAt } : { status, endedAt, detail },
        );
      });
    }

    function reportDefect(execution: EffectExecution, cause: unknown) {
      return Effect.gen(function* () {
        yield* config.supervise({
          executionId: execution.id,
          effect: execution.effect,
          cause,
          actor: execution.actor,
        });
        yield* end(execution, "defect", Cause.pretty(cause as Cause.Cause<unknown>));
      });
    }

    function dispatchMappedOutcome(
      execution: EffectExecution,
      lease: Lease,
      outcome: CommandInvocation<string, unknown> | void,
      terminalStatus: "succeeded" | "failed",
    ) {
      return Effect.gen(function* () {
        if (!current(lease)) return yield* end(execution, "stale");
        if (execution.mode === "manual-replay" || outcome === undefined) {
          return yield* end(execution, terminalStatus);
        }
        const result = yield* Effect.exit(config.dispatchOutcome(outcome, execution));
        if (Exit.isFailure(result)) {
          return yield* reportDefect(execution, result.cause);
        }
        if (result.value._tag !== "Accepted") return yield* end(execution, "stale");
        yield* update(execution.id, { status: "outcome-dispatched" });
        return yield* end(execution, terminalStatus);
      });
    }

    function runExecution(
      definition: ErasedEffect,
      invocation: CommittedEffectInvocation,
      execution: EffectExecution,
      lease: Lease,
      renderToken: RenderToken | undefined,
      executionScope: Scope.Scope,
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        const context: EffectRunContext = {
          executionId: execution.id,
          invocationId: invocation.id,
          commandId: invocation.commandId,
          commitId: invocation.commitId,
          correlationId: invocation.correlationId,
          actor: invocation.actor,
          mode: execution.mode,
          attempt: 1,
          ensureCurrent: Effect.suspend(() =>
            current(lease)
              ? Effect.void
              : Effect.fail(new StaleExecution("The execution lease is no longer current")),
          ),
        };
        const body = Effect.gen(function* () {
          if (renderToken) {
            yield* config.awaitRender(renderToken);
            lease.awaitingRender = false;
          }
          yield* context.ensureCurrent;
          const startedAt = yield* config.now;
          yield* update(execution.id, { status: "running", startedAt });
          const allowedContext =
            execution.mode === "manual-replay" ? manualReplayContext : liveContext;
          return yield* effectProgram(definition, invocation.args, context).pipe(
            Effect.provideContext(Context.add(allowedContext, Scope.Scope, executionScope)),
            Effect.withSpan(definition.name, {
              attributes: {
                "cab.execution.id": execution.id,
                "cab.invocation.id": invocation.id,
                "cab.commit.id": invocation.commitId,
                "cab.correlation.id": invocation.correlationId,
                "cab.effect.phase": invocation.phase,
              },
            }),
          );
        });
        const result = yield* Effect.exit(body);
        if (Exit.isSuccess(result)) {
          if (execution.mode === "manual-replay") {
            return yield* end(execution, "succeeded");
          }
          const mapped = yield* Effect.exit(
            Effect.sync(() => definition.onSuccess?.(result.value, invocation.args, context)),
          );
          if (Exit.isFailure(mapped)) return yield* reportDefect(execution, mapped.cause);
          return yield* dispatchMappedOutcome(execution, lease, mapped.value, "succeeded");
        }

        const cause = result.cause;
        if (Cause.hasInterrupts(cause)) return yield* end(execution, "interrupted");
        const failure = Cause.findErrorOption(cause);
        if (Option.isSome(failure)) {
          if (
            failure.value instanceof StaleExecution ||
            failure.value instanceof RenderBarrierError
          ) {
            return yield* end(execution, "stale");
          }
          if (execution.mode === "manual-replay") {
            return yield* end(execution, "failed");
          }
          const mapped = yield* Effect.exit(
            Effect.sync(() => definition.onFailure?.(failure.value, invocation.args, context)),
          );
          if (Exit.isFailure(mapped)) return yield* reportDefect(execution, mapped.cause);
          return yield* dispatchMappedOutcome(execution, lease, mapped.value, "failed");
        }
        return yield* reportDefect(execution, cause);
      }).pipe(
        Effect.onInterrupt(() => end(execution, "interrupted")),
        Effect.ensuring(
          Effect.sync(() => {
            runningFibers.delete(execution.id);
          }),
        ),
      );
    }

    function schedule(
      invocation: CommittedEffectInvocation,
      mode: "live" | "manual-replay",
      replayToken?: RenderToken,
    ) {
      return Effect.gen(function* () {
        const definition = config.registry.effectByName.get(invocation.definition);
        if (!definition || definition.version !== invocation.version) {
          return yield* Effect.die(
            `Missing effect definition ${invocation.definition}@${invocation.version}`,
          );
        }
        const executionId = yield* config.nextId("execution");
        let concurrencyKey: string | undefined;
        let generation = 1;
        if (definition.concurrency._tag === "Latest") {
          if (mode === "live") {
            concurrencyKey = invocation.concurrencyKey;
            if (concurrencyKey === undefined) {
              return yield* Effect.die(`Missing Latest key for ${invocation.definition}`);
            }
          } else {
            const concurrency = definition.concurrency;
            const keyed = yield* Effect.exit(Effect.sync(() => concurrency.key(invocation.args)));
            if (Exit.isFailure(keyed) || typeof keyed.value !== "string") {
              return yield* Effect.die(`Invalid Latest key for ${invocation.definition}`);
            }
            concurrencyKey = effectConcurrencyKey(definition.name, keyed.value);
          }
          const latestByKey = mode === "manual-replay" ? replayLatestByKey : liveLatestByKey;
          const previous = latestByKey.get(concurrencyKey);
          generation = (previous?.generation ?? 0) + 1;
          if (previous) {
            const previousLease = leases.get(previous.executionId);
            if (previousLease) previousLease.active = false;
          }
          latestByKey.set(concurrencyKey, { executionId, generation });
        }
        const executionRenderToken =
          mode === "manual-replay" ? replayToken : invocation.renderToken;
        const lease: Lease = {
          executionId,
          invocationId: invocation.id,
          mode,
          branchEpoch: mode === "manual-replay" ? config.branchEpoch() : invocation.branchEpoch,
          generation,
          ...(concurrencyKey === undefined ? {} : { concurrencyKey }),
          ...(executionRenderToken === undefined ? {} : { renderToken: executionRenderToken }),
          awaitingRender: executionRenderToken !== undefined,
          active: true,
        };
        leases.set(executionId, lease);
        const invocationSet = invocationExecutions.get(invocation.id) ?? new Set<string>();
        invocationSet.add(executionId);
        invocationExecutions.set(invocation.id, invocationSet);
        const execution: EffectExecution = {
          id: executionId,
          invocationId: invocation.id,
          effect: invocation.definition,
          version: invocation.version,
          args: invocation.args,
          commandId: invocation.commandId,
          commitId: invocation.commitId,
          correlationId: invocation.correlationId,
          actor: invocation.actor,
          branchId: invocation.branchId,
          branchEpoch: invocation.branchEpoch,
          phase: invocation.phase,
          mode,
          ...(concurrencyKey === undefined ? {} : { concurrencyKey }),
          attempt: 1,
          status: invocation.phase === "after-render" ? "awaiting-render" : "pending",
        };
        const immutableExecution = cloneSerializable(execution);
        telemetry = cloneSerializable([...telemetry, immutableExecution]);
        yield* PubSub.publish(telemetryPubSub, immutableExecution);
        let program = Effect.scopedWith((executionScope) =>
          runExecution(
            definition,
            invocation,
            execution,
            lease,
            executionRenderToken,
            executionScope,
          ),
        );
        if (definition.concurrency._tag === "Every" && definition.concurrency.limit !== undefined) {
          let semaphore = everyLimits.get(definition.name);
          if (!semaphore) {
            semaphore = Semaphore.makeUnsafe(definition.concurrency.limit);
            everyLimits.set(definition.name, semaphore);
          }
          program = semaphore.withPermit(program);
        }
        const launch = Deferred.makeUnsafe<void>();
        const ownedProgram = Deferred.await(launch).pipe(Effect.andThen(program));
        const latestFibers = mode === "manual-replay" ? replayLatestFibers : liveLatestFibers;
        const fiber = concurrencyKey
          ? yield* FiberMap.run(latestFibers, concurrencyKey, ownedProgram)
          : yield* FiberSet.run(everyFibers, ownedProgram);
        runningFibers.set(executionId, fiber);
        yield* Deferred.succeed(launch, undefined);
        return executionId;
      });
    }

    return {
      submit: (invocation) => schedule(invocation, "live"),
      replay: (request) =>
        Effect.gen(function* () {
          if (!request.allow) {
            return yield* Effect.fail(
              new ReplayRejected({
                code: "consent-required",
                message: "Manual effect replay requires explicit user consent",
              }),
            );
          }
          const definition = config.registry.effectByName.get(request.invocation.definition);
          if (!definition) {
            return yield* Effect.fail(
              new ReplayRejected({
                code: "replay-forbidden",
                message: `Effect "${request.invocation.definition}" is not registered`,
              }),
            );
          }
          if (definition.version !== request.invocation.version) {
            return yield* Effect.fail(
              new ReplayRejected({
                code: "version-mismatch",
                message: `Effect "${request.invocation.definition}" version does not match`,
              }),
            );
          }
          if (definition.replay !== "manual") {
            return yield* Effect.fail(
              new ReplayRejected({
                code: "replay-forbidden",
                message: `Effect "${request.invocation.definition}" does not permit replay`,
              }),
            );
          }
          const acknowledged = yield* config.isRenderAcknowledged(request.renderToken);
          if (!acknowledged) {
            return yield* Effect.fail(
              new ReplayRejected({
                code: "render-not-acknowledged",
                message: "The selected historical render has not been acknowledged",
              }),
            );
          }
          const executionId = yield* schedule(
            request.invocation,
            "manual-replay",
            request.renderToken,
          );
          return { executionId, invocationId: request.invocation.id };
        }),
      fenceInvocations: (removedInvocationIds) =>
        Effect.sync(() => {
          const fibers: Fiber.Fiber<void, never>[] = [];
          for (const invocationId of removedInvocationIds) {
            for (const executionId of invocationExecutions.get(invocationId) ?? []) {
              const lease = leases.get(executionId);
              if (lease) lease.active = false;
              const fiber = runningFibers.get(executionId);
              if (fiber) fibers.push(fiber);
            }
          }
          return fibers;
        }),
      rebaseInvocations: (retainedInvocationIds, nextBranchEpoch) =>
        Effect.sync(() => {
          for (const invocationId of retainedInvocationIds) {
            for (const executionId of invocationExecutions.get(invocationId) ?? []) {
              const lease = leases.get(executionId);
              if (lease?.active) lease.branchEpoch = nextBranchEpoch;
            }
          }
        }),
      supersedeRender: (token) =>
        Effect.gen(function* () {
          const fibers: Fiber.Fiber<void, never>[] = [];
          for (const lease of leases.values()) {
            const selected = lease.renderToken;
            if (
              !lease.active ||
              selected === undefined ||
              selected.rendererId !== token.rendererId ||
              (selected.revision === token.revision &&
                selected.sequence === token.sequence &&
                selected.mode === token.mode)
            ) {
              continue;
            }
            if (
              lease.mode === "live" &&
              (!lease.awaitingRender || (yield* config.isRenderAcknowledged(selected)))
            ) {
              continue;
            }
            lease.active = false;
            const fiber = runningFibers.get(lease.executionId);
            if (fiber) fibers.push(fiber);
          }
          if (fibers.length > 0) yield* Fiber.interruptAll(fibers);
        }),
      isCurrent: (executionId) => {
        const lease = leases.get(executionId);
        return lease !== undefined && current(lease);
      },
      executions: Effect.sync(() => telemetry),
      changes: Stream.fromPubSub(telemetryPubSub),
    } satisfies EffectExecutor;
  });
}
