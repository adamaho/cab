import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
  type Scope,
} from "effect";
import {
  effectConcurrencyKey,
  type CommandInvocation,
  type EffectInvocation,
  type EventInvocation,
} from "./definition.ts";
import { type CommandRejection, type Decision } from "./decision.ts";
import {
  makeEffectExecutor,
  ReplayRejected,
  type EffectExecutor,
  type ReplayResult,
} from "./executor.ts";
import {
  DefinitionRegistryError,
  cloneSerializable,
  makeFeatureRegistry,
  type FeatureLike,
  type FeatureRegistry,
  type RequirementsOf,
  type StateOf,
} from "./feature.ts";
import { Journal, JournalCommitError } from "./journal.ts";
import type {
  Actor,
  CommandDescription,
  CommandEnvelope,
  CommandOrigin,
  CommitEnvelope,
  CommittedEffectInvocation,
  EffectExecution,
  Fact,
  HistoricalSnapshot,
  RenderToken,
  RuntimeDescription,
  RuntimeRevision,
  RuntimeSnapshot,
} from "./model.ts";
import { QueryCache, runQuery } from "./query.ts";
import { IdGenerator, RenderCoordinator, RuntimeClock, RuntimeSupervisor } from "./services.ts";

/** Is the data result of a command dispatch. @category runtime @since 0.0.0 */
export type DispatchResult =
  | {
      readonly _tag: "Accepted";
      readonly command: CommandEnvelope;
      readonly commit: CommitEnvelope;
      readonly facts: readonly Fact[];
      readonly effectInvocationIds: readonly string[];
    }
  | {
      readonly _tag: "Rejected";
      readonly command: CommandEnvelope;
      readonly rejection: CommandRejection;
    }
  | { readonly _tag: "Noop"; readonly command: CommandEnvelope; readonly reason?: string };

/** Reports an invalid historical sequence. @category errors @since 0.0.0 */
export class HistoryError extends Data.TaggedError("HistoryError")<{
  readonly sequence: number;
  readonly headSequence: number;
  readonly message: string;
}> {}

/** Reports an operation attempted after scoped runtime shutdown. @category errors @since 0.0.0 */
export class RuntimeClosedError extends Data.TaggedError("RuntimeClosedError")<{
  readonly message: string;
}> {}

/** Requests explicit replay of one visible manual invocation. @category replay @since 0.0.0 */
export interface RuntimeReplayRequest {
  readonly invocationId: string;
  readonly rendererId: string;
  readonly allow: boolean;
}

/** Is the Effect-native command, history, rendering, replay, and telemetry surface. @category runtime @since 0.0.0 */
export interface CabRuntime<State> {
  readonly dispatch: <Name extends string, Args>(
    invocation: CommandInvocation<Name, Args>,
    actor: Actor,
  ) => Effect.Effect<DispatchResult, JournalCommitError | RuntimeClosedError>;
  readonly dispatchUnknown: (
    name: string,
    args: unknown,
    actor: Actor,
  ) => Effect.Effect<DispatchResult, JournalCommitError | RuntimeClosedError>;
  readonly snapshot: Effect.Effect<RuntimeSnapshot<State>>;
  readonly changes: Stream.Stream<RuntimeRevision<State>>;
  readonly stateAt: (
    sequence: number,
  ) => Effect.Effect<HistoricalSnapshot<State>, HistoryError | JournalCommitError>;
  readonly scrub: (
    sequence: number,
  ) => Effect.Effect<RuntimeRevision<State>, HistoryError | JournalCommitError>;
  readonly live: Effect.Effect<RuntimeRevision<State>, JournalCommitError>;
  readonly continueFrom: (
    sequence?: number,
  ) => Effect.Effect<RuntimeRevision<State>, HistoryError | JournalCommitError>;
  readonly acknowledgeRender: (token: RenderToken) => Effect.Effect<void>;
  readonly replayEffect: (
    request: RuntimeReplayRequest,
  ) => Effect.Effect<ReplayResult, ReplayRejected | JournalCommitError>;
  readonly describe: Effect.Effect<RuntimeDescription>;
  readonly executions: Effect.Effect<readonly EffectExecution[]>;
  readonly executionChanges: Stream.Stream<EffectExecution>;
}

type RuntimeState = Readonly<Record<string, unknown>>;

function initialState(registry: FeatureRegistry): RuntimeState {
  return cloneSerializable(
    Object.fromEntries(registry.features.map((feature) => [feature.name, feature.initialState])),
  );
}

function foldFact(registry: FeatureRegistry, state: RuntimeState, fact: Fact): RuntimeState {
  const definition = registry.eventByName.get(fact.name);
  if (!definition || definition.version !== fact.version) {
    throw new Error(`Unknown event "${fact.name}@${fact.version}"`);
  }
  const safeFact = cloneSerializable({
    ...fact,
    args: decode(definition.schema, fact.args),
  });
  return cloneSerializable(
    Object.fromEntries(
      registry.features.map((feature) => [
        feature.name,
        cloneSerializable(feature.reduce(state[feature.name], safeFact)),
      ]),
    ),
  );
}

function validateFactSequence(facts: readonly Fact[]): void {
  for (let index = 0; index < facts.length; index += 1) {
    if (facts[index]?.sequence !== index + 1) {
      throw new Error(`Invalid fact sequence at journal index ${index}`);
    }
  }
}

function foldFacts(
  registry: FeatureRegistry,
  facts: readonly Fact[],
  startingState: RuntimeState = initialState(registry),
): RuntimeState {
  return facts.reduce((state, fact) => foldFact(registry, state, fact), startingState);
}

function decode<S extends Schema.Schema<unknown>>(schema: S, value: unknown): unknown {
  return Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>)(value);
}

function rejection(command: CommandEnvelope, value: CommandRejection): DispatchResult {
  return { _tag: "Rejected", command, rejection: value };
}

interface AcceptedWork {
  readonly result: DispatchResult;
}

type SchedulerTask =
  | { readonly _tag: "DrainOutbox" }
  | { readonly _tag: "SupersedeRender"; readonly token: RenderToken };

/** Builds a scoped runtime over a validated vertical feature registry. @category runtime @since 0.0.0 */
export function createRuntime<const Features extends readonly FeatureLike[]>(config: {
  readonly features: Features;
  readonly rendererId?: string;
  readonly replayContext?: Context.Context<never>;
}): Effect.Effect<
  CabRuntime<StateOf<Features>>,
  DefinitionRegistryError | JournalCommitError,
  | Scope.Scope
  | Journal
  | IdGenerator
  | RuntimeClock
  | RenderCoordinator
  | RuntimeSupervisor
  | QueryCache
  | RequirementsOf<Features>
> {
  const program = Effect.gen(function* () {
    const registry = yield* makeFeatureRegistry(config.features);
    const journal = yield* Journal;
    const ids = yield* IdGenerator;
    const clock = yield* RuntimeClock;
    const render = yield* RenderCoordinator;
    const supervisor = yield* RuntimeSupervisor;
    const queryCache = yield* QueryCache;
    const effectContext = yield* Effect.context<RequirementsOf<Features>>();
    const dispatchLock = Semaphore.makeUnsafe(1);
    const schedulerLock = Semaphore.makeUnsafe(1);
    const schedulerQueue = yield* Queue.unbounded<SchedulerTask>();
    const revisionPubSub = yield* PubSub.unbounded<RuntimeRevision<RuntimeState>>();
    const opened = yield* journal.snapshot;
    let liveState: RuntimeState;
    try {
      validateFactSequence(opened.facts);
      liveState = foldFacts(registry, opened.facts);
    } catch (cause) {
      return yield* Effect.fail(
        new JournalCommitError({
          code: "fold-defect",
          message: "The opened journal failed validation or folding",
          cause,
        }),
      );
    }
    let viewState = liveState;
    let viewingSequence = opened.facts.length;
    let branchId = opened.branchId;
    let branchEpoch = opened.branchEpoch;
    const latestCommittedByKey = new Map<string, string>();
    for (const invocation of opened.invocations) {
      if (invocation.concurrencyKey) {
        latestCommittedByKey.set(invocation.concurrencyKey, invocation.id);
      }
    }
    let revision = 0;
    let mode: "live" | "historical" = "live";
    let accepting = true;
    let continuationGate: Deferred.Deferred<void> | undefined;
    let closed = false;
    const rendererId = config.rendererId ?? "solid";
    let renderToken: RenderToken = cloneSerializable({
      rendererId,
      revision,
      sequence: viewingSequence,
      mode,
    });
    let executor: EffectExecutor;

    function publish(facts: readonly Fact[]) {
      return Effect.gen(function* () {
        revision += 1;
        renderToken = makeRenderToken(revision, viewingSequence, mode);
        const head = yield* journal.snapshot;
        const value = cloneSerializable<RuntimeRevision<RuntimeState>>({
          revision,
          sequence: viewingSequence,
          headSequence: head.facts.length,
          mode,
          state: viewState,
          facts,
          renderToken,
        });
        yield* render.publish(renderToken);
        yield* PubSub.publish(revisionPubSub, value);
        yield* Queue.offer(schedulerQueue, { _tag: "SupersedeRender", token: renderToken });
        return value;
      });
    }

    function makeRenderToken(
      tokenRevision: number,
      sequence: number,
      tokenMode: "live" | "historical",
    ): RenderToken {
      return cloneSerializable({
        rendererId,
        revision: tokenRevision,
        sequence,
        mode: tokenMode,
      });
    }

    yield* render.publish(renderToken);

    function makeEnvelope(
      name: string,
      args: unknown,
      actor: Actor,
      origin: CommandOrigin,
      inherited?: {
        readonly correlationId: string;
        readonly causationId: string;
      },
    ) {
      return Effect.gen(function* () {
        const id = yield* ids.next("command");
        const issuedAt = yield* clock.now;
        return yield* Effect.try({
          try: () =>
            cloneSerializable({
              id,
              name,
              args,
              actor,
              issuedAt,
              correlationId: inherited?.correlationId ?? id,
              ...(inherited ? { causationId: inherited.causationId } : {}),
              origin,
            } satisfies CommandEnvelope),
          catch: (cause) =>
            new JournalCommitError({
              code: "unserializable",
              message: `Command "${name}" is not serializable`,
              cause,
            }),
        });
      });
    }

    function runEnvelope(
      command: CommandEnvelope,
    ): Effect.Effect<AcceptedWork, JournalCommitError | RuntimeClosedError> {
      return dispatchLock.withPermit(
        Effect.gen(function* () {
          if (closed) {
            return yield* Effect.fail(
              new RuntimeClosedError({ message: "The Cab runtime scope is closed" }),
            );
          }
          if (!accepting) {
            return {
              result: rejection(command, {
                code: "runtime.branch.continuing",
                message: "Commands are paused while history continuation is in progress",
              }),
              invocations: [],
            };
          }
          if (command.origin._tag === "Actor" && mode === "historical") {
            return {
              result: rejection(command, {
                code: "runtime.history.read-only",
                message: "Commands are disabled while viewing history",
              }),
              invocations: [],
            };
          }
          if (command.origin._tag === "Effect" && !executor.isCurrent(command.origin.executionId)) {
            return {
              result: rejection(command, {
                code: "runtime.effect.stale",
                message: "The effect execution lease is no longer current",
              }),
              invocations: [],
            };
          }
          const definition = registry.commandByName.get(command.name);
          if (!definition) {
            return {
              result: rejection(command, {
                code: "runtime.command.unknown",
                message: `Unknown command "${command.name}"`,
              }),
              invocations: [],
            };
          }
          if ((definition.exposure === "outcome") !== (command.origin._tag === "Effect")) {
            return {
              result: rejection(command, {
                code: "runtime.command.forbidden",
                message:
                  definition.exposure === "outcome"
                    ? `Command "${command.name}" is runtime-only`
                    : "Effects may dispatch only registered outcome commands",
              }),
              invocations: [],
            };
          }
          let args: unknown;
          try {
            args = cloneSerializable(decode(definition.args, command.args));
          } catch (cause) {
            return {
              result: rejection(command, {
                code: "runtime.command.invalid-args",
                message: `Invalid command arguments: ${String(cause)}`,
              }),
              invocations: [],
            };
          }
          const featureName = registry.commandFeature.get(command.name);
          if (!featureName) {
            return yield* Effect.fail(
              new JournalCommitError({
                code: "invalid-definition",
                message: `Command "${command.name}" has no owning feature`,
              }),
            );
          }
          let decision: Decision;
          try {
            decision = definition.decide(
              {
                state: liveState[featureName] as Readonly<unknown>,
                command,
                query: (query) => runQuery(query, liveState, queryCache),
              },
              args,
            );
          } catch (cause) {
            return yield* Effect.fail(
              new JournalCommitError({
                code: "decision-defect",
                message: `Decision for "${command.name}" threw`,
                cause,
              }),
            );
          }
          if (decision._tag === "Rejected") {
            return { result: rejection(command, decision.rejection), invocations: [] };
          }
          if (decision._tag === "Noop") {
            return {
              result:
                decision.reason === undefined
                  ? { _tag: "Noop", command }
                  : { _tag: "Noop", command, reason: decision.reason },
              invocations: [],
            };
          }

          if (decision.events.length === 0) {
            return yield* Effect.fail(
              new JournalCommitError({
                code: "invalid-definition",
                message: `Accepted decision for "${command.name}" contains no events`,
              }),
            );
          }
          const eventValues: EventInvocation<string, unknown>[] = [];
          for (const proposal of decision.events) {
            const eventDefinition = registry.eventByName.get(proposal.event);
            if (!eventDefinition || eventDefinition.version !== proposal.version) {
              return yield* Effect.fail(
                new JournalCommitError({
                  code: "invalid-definition",
                  message: `Unknown event proposal "${proposal.event}@${proposal.version}"`,
                }),
              );
            }
            try {
              const decoded = decode(eventDefinition.schema, proposal.args);
              const redacted = eventDefinition.redact ? eventDefinition.redact(decoded) : decoded;
              eventValues.push(
                cloneSerializable({ ...proposal, args: decode(eventDefinition.schema, redacted) }),
              );
            } catch (cause) {
              return yield* Effect.fail(
                new JournalCommitError({
                  code: "invalid-definition",
                  message: `Event proposal "${proposal.event}" failed validation`,
                  cause,
                }),
              );
            }
          }
          const effectValues: EffectInvocation<string, unknown>[] = [];
          const effectKeys: Array<string | undefined> = [];
          for (const proposal of decision.effects) {
            const effectDefinition = registry.effectByName.get(proposal.effect);
            if (!effectDefinition || effectDefinition.version !== proposal.version) {
              return yield* Effect.fail(
                new JournalCommitError({
                  code: "invalid-definition",
                  message: `Unknown effect proposal "${proposal.effect}@${proposal.version}"`,
                }),
              );
            }
            try {
              const decodedArgs = cloneSerializable(decode(effectDefinition.args, proposal.args));
              let concurrencyKey: string | undefined;
              if (effectDefinition.concurrency._tag === "Latest") {
                const key = effectDefinition.concurrency.key(decodedArgs);
                if (typeof key !== "string") throw new TypeError("Latest key must be a string");
                concurrencyKey = effectConcurrencyKey(effectDefinition.name, key);
              }
              effectValues.push(cloneSerializable({ ...proposal, args: decodedArgs }));
              effectKeys.push(concurrencyKey);
            } catch (cause) {
              return yield* Effect.fail(
                new JournalCommitError({
                  code: "invalid-definition",
                  message: `Effect proposal "${proposal.effect}" failed validation`,
                  cause,
                }),
              );
            }
          }

          const before = yield* journal.snapshot;
          const commitId = yield* ids.next("commit");
          const committedAt = yield* clock.now;
          const commit = cloneSerializable<CommitEnvelope>({
            id: commitId,
            branchId,
            branchEpoch,
            commandId: command.id,
            correlationId: command.correlationId,
            committedAt,
          });
          const facts: Fact[] = [];
          for (let index = 0; index < eventValues.length; index += 1) {
            const event = eventValues[index];
            if (!event) continue;
            facts.push(
              cloneSerializable({
                id: yield* ids.next("fact"),
                sequence: before.facts.length + index + 1,
                name: event.event,
                version: event.version,
                args: event.args,
                actor: command.actor,
                commandId: command.id,
                commitId,
                correlationId: command.correlationId,
                causationId: command.causationId ?? command.id,
                branchId,
                branchEpoch,
                at: committedAt,
              }),
            );
          }
          let nextState: RuntimeState;
          try {
            nextState = foldFacts(registry, facts, liveState);
          } catch (cause) {
            return yield* Effect.fail(
              new JournalCommitError({
                code: "fold-defect",
                message: `Fact batch for "${command.name}" failed to fold`,
                cause,
              }),
            );
          }
          const triggeringSequence = facts.at(-1)?.sequence ?? before.facts.length;
          const nextToken = makeRenderToken(
            revision + 1,
            mode === "live" ? triggeringSequence : viewingSequence,
            mode,
          );
          const invocations: CommittedEffectInvocation[] = effectValues.map((effect, ordinal) => {
            const effectDefinition = registry.effectByName.get(effect.effect);
            if (!effectDefinition) throw new Error(`Missing effect "${effect.effect}"`);
            return cloneSerializable({
              id: `${command.id}:${ordinal}:${effect.version}`,
              definition: effect.effect,
              version: effect.version,
              args: effect.args,
              ordinal,
              commandId: command.id,
              commitId,
              correlationId: command.correlationId,
              actor: command.actor,
              branchId,
              branchEpoch,
              triggerSequence: triggeringSequence,
              phase: effectDefinition.phase,
              replay: effectDefinition.replay,
              authority: effectDefinition.authority,
              ...(effectKeys[ordinal] === undefined ? {} : { concurrencyKey: effectKeys[ordinal] }),
              ...(effectDefinition.phase === "after-render" ? { renderToken: nextToken } : {}),
              status: "pending" as const,
            });
          });
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* journal.commit(
                cloneSerializable({
                  commit,
                  expectedHeadSequence: before.facts.length,
                  facts,
                  invocations,
                }),
              );
              yield* Queue.offer(schedulerQueue, { _tag: "DrainOutbox" });
              liveState = nextState;
              for (const invocation of invocations) {
                if (invocation.concurrencyKey) {
                  latestCommittedByKey.set(invocation.concurrencyKey, invocation.id);
                }
              }
              if (mode === "live") {
                viewState = liveState;
                viewingSequence = triggeringSequence;
              }
              yield* publish(facts);
            }),
          );
          return {
            result: {
              _tag: "Accepted",
              command,
              commit,
              facts,
              effectInvocationIds: invocations.map((item) => item.id),
            },
            invocations,
          };
        }),
      );
    }

    function executeEnvelope(command: CommandEnvelope) {
      return runEnvelope(command).pipe(Effect.map((work) => work.result));
    }

    executor = yield* makeEffectExecutor({
      registry,
      effectContext,
      replayContext: config.replayContext ?? Context.empty(),
      nextId: ids.next,
      now: clock.now,
      branchEpoch: () => branchEpoch,
      isInvocationCurrent: (invocationId, concurrencyKey) =>
        concurrencyKey === undefined || latestCommittedByKey.get(concurrencyKey) === invocationId,
      compareAndSetInvocationStatus: journal.compareAndSetInvocationStatus,
      awaitRender: render.await,
      isRenderAcknowledged: render.isAcknowledged,
      dispatchOutcome: (invocation, execution) =>
        Effect.gen(function* () {
          const gate = continuationGate;
          if (gate) yield* Deferred.await(gate);
          const envelope = yield* makeEnvelope(
            invocation.command,
            invocation.args,
            execution.actor,
            { _tag: "Effect", executionId: execution.id },
            {
              correlationId: execution.correlationId,
              causationId: execution.invocationId,
            },
          );
          return yield* executeEnvelope(envelope);
        }),
      supervise: supervisor.report,
    });

    function validateOutboxInvocation(
      invocation: CommittedEffectInvocation,
    ):
      | { readonly _tag: "Valid"; readonly invocation: CommittedEffectInvocation }
      | { readonly _tag: "Invalid"; readonly detail: string } {
      const definition = registry.effectByName.get(invocation.definition);
      if (!definition || definition.version !== invocation.version) {
        return {
          _tag: "Invalid",
          detail: `Missing effect definition ${invocation.definition}@${invocation.version}`,
        };
      }
      if (
        invocation.phase !== definition.phase ||
        invocation.replay !== definition.replay ||
        invocation.authority !== definition.authority ||
        (definition.phase === "after-render") !== (invocation.renderToken !== undefined)
      ) {
        return { _tag: "Invalid", detail: `Policy mismatch for ${invocation.definition}` };
      }
      try {
        const args = cloneSerializable(decode(definition.args, invocation.args));
        if (definition.concurrency._tag !== "Latest") {
          return invocation.concurrencyKey === undefined
            ? { _tag: "Valid", invocation: cloneSerializable({ ...invocation, args }) }
            : { _tag: "Invalid", detail: `Unexpected Latest key for ${invocation.definition}` };
        }
        const key = definition.concurrency.key(args);
        if (typeof key !== "string") {
          return { _tag: "Invalid", detail: `Invalid Latest key for ${invocation.definition}` };
        }
        return invocation.concurrencyKey === effectConcurrencyKey(definition.name, key)
          ? { _tag: "Valid", invocation: cloneSerializable({ ...invocation, args }) }
          : { _tag: "Invalid", detail: `Mismatched Latest key for ${invocation.definition}` };
      } catch (cause) {
        return {
          _tag: "Invalid",
          detail: `Outbox validation failed for ${invocation.definition}: ${String(cause)}`,
        };
      }
    }

    function drainOutbox() {
      return Effect.gen(function* () {
        while (true) {
          const invocation = yield* journal.claimNextPending;
          if (!invocation) return;
          const validated = validateOutboxInvocation(invocation);
          if (validated._tag === "Invalid") {
            yield* Effect.ignore(
              journal.compareAndSetInvocationStatus(invocation.id, "claimed", "cancelled"),
            );
            yield* supervisor.report({
              executionId: `outbox:${invocation.id}`,
              effect: invocation.definition,
              cause: validated.detail,
              actor: invocation.actor,
            });
            continue;
          }
          const submitted = yield* Effect.exit(
            Effect.uninterruptible(executor.submit(validated.invocation)),
          );
          if (Exit.isSuccess(submitted)) continue;
          yield* Effect.ignore(
            journal.compareAndSetInvocationStatus(invocation.id, "claimed", "cancelled"),
          );
          yield* supervisor.report({
            executionId: `outbox:${invocation.id}`,
            effect: invocation.definition,
            cause: Cause.pretty(submitted.cause),
            actor: invocation.actor,
          });
        }
      });
    }

    yield* journal.recoverClaimed;
    yield* journal.rebasePendingRenderTokens(renderToken);
    yield* schedulerLock.withPermit(drainOutbox());
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const task = yield* Queue.take(schedulerQueue);
          yield* schedulerLock.withPermit(
            Effect.gen(function* () {
              yield* dispatchLock.withPermit(Effect.void);
              if (task._tag === "SupersedeRender") {
                yield* executor.supersedeRender(task.token);
              }
              yield* drainOutbox();
            }),
          );
        }),
      ),
    );

    function historyPrefix(sequence: number) {
      return Effect.gen(function* () {
        const snapshot = yield* journal.snapshot;
        if (sequence < 0 || sequence > snapshot.facts.length || !Number.isInteger(sequence)) {
          return yield* Effect.fail(
            new HistoryError({
              sequence,
              headSequence: snapshot.facts.length,
              message: `Sequence ${sequence} is outside the journal`,
            }),
          );
        }
        yield* Effect.try({
          try: () => validateFactSequence(snapshot.facts),
          catch: (cause) =>
            new JournalCommitError({
              code: "fold-defect",
              message: `Historical fold failed at sequence ${sequence}`,
              cause,
            }),
        });
        return { facts: snapshot.facts.slice(0, sequence), snapshot };
      });
    }

    function foldHistorical(
      sequence: number,
      facts: readonly Fact[],
    ): Effect.Effect<RuntimeState, JournalCommitError> {
      return Effect.try({
        try: () => {
          validateFactSequence(facts);
          return foldFacts(registry, facts);
        },
        catch: (cause) =>
          new JournalCommitError({
            code: "fold-defect",
            message: `Historical fold failed at sequence ${sequence}`,
            cause,
          }),
      });
    }

    function historical(sequence: number) {
      return Effect.gen(function* () {
        const value = yield* historyPrefix(sequence);
        const state = yield* foldHistorical(sequence, value.facts);
        return { ...value, state };
      });
    }

    const description: RuntimeDescription = {
      features: registry.features.map((feature) => feature.name),
      commands: [...registry.commandByName.values()]
        .filter((command) => command.exposure === "public")
        .map((command): CommandDescription => {
          return {
            name: command.name,
            description: command.description,
            argsSchema: Schema.toJsonSchemaDocument(command.args),
            possibleEffects: (command.possibleEffects ?? []).flatMap((name) => {
              const effect = registry.effectByName.get(name);
              return effect
                ? [{ name: effect.name, phase: effect.phase, replay: effect.replay }]
                : [];
            }),
          };
        }),
      events: [...registry.eventByName.keys()],
      effects: [...registry.effectByName.values()].map((effect) => ({
        name: effect.name,
        version: effect.version,
        description: effect.description,
        phase: effect.phase,
        replay: effect.replay,
        authority: effect.authority,
        concurrency: effect.concurrency._tag,
      })),
    };

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        accepting = false;
        yield* Queue.shutdown(schedulerQueue);
      }),
    );

    const runtime: CabRuntime<RuntimeState> = {
      dispatch: (invocation, actor) =>
        Effect.gen(function* () {
          const envelope = yield* makeEnvelope(invocation.command, invocation.args, actor, {
            _tag: "Actor",
          });
          return yield* executeEnvelope(envelope);
        }),
      dispatchUnknown: (name, args, actor) =>
        Effect.gen(function* () {
          const envelope = yield* makeEnvelope(name, args, actor, { _tag: "Actor" });
          return yield* executeEnvelope(envelope);
        }),
      snapshot: dispatchLock.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* journal.snapshot;
          return cloneSerializable<RuntimeSnapshot<RuntimeState>>({
            state: viewState,
            liveState,
            journal: snapshot.facts,
            invocations: snapshot.invocations,
            sequence: viewingSequence,
            headSequence: snapshot.facts.length,
            revision,
            mode,
            branchId,
            branchEpoch,
            renderToken,
          });
        }),
      ),
      changes: Stream.fromPubSub(revisionPubSub),
      stateAt: (sequence) =>
        Effect.gen(function* () {
          const value = yield* historical(sequence);
          return {
            state: value.state,
            sequence,
            facts: value.facts,
            branchId: value.snapshot.branchId,
          };
        }),
      scrub: (sequence) =>
        schedulerLock.withPermit(
          dispatchLock.withPermit(
            Effect.gen(function* () {
              const value = yield* historical(sequence);
              viewState = value.state;
              viewingSequence = sequence;
              mode = sequence === value.snapshot.facts.length ? "live" : "historical";
              if (mode === "live") viewState = liveState;
              return yield* publish([]);
            }),
          ),
        ),
      live: schedulerLock.withPermit(
        dispatchLock.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* journal.snapshot;
            viewingSequence = snapshot.facts.length;
            viewState = liveState;
            mode = "live";
            return yield* publish([]);
          }),
        ),
      ),
      continueFrom: (requestedSequence) =>
        Effect.acquireUseRelease(
          Deferred.make<void>(),
          (gate) =>
            schedulerLock.withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  continuationGate = gate;
                  const plan = yield* dispatchLock.withPermit(
                    Effect.gen(function* () {
                      const sequence = requestedSequence ?? viewingSequence;
                      const value = yield* historyPrefix(sequence);
                      accepting = false;
                      const nextBranchId = yield* ids.next("branch");
                      const nextBranchEpoch = branchEpoch + 1;
                      const removedIds = new Set(
                        value.snapshot.invocations
                          .filter((invocation) => invocation.triggerSequence > sequence)
                          .map((invocation) => invocation.id),
                      );
                      const retainedIds = new Set(
                        value.snapshot.invocations
                          .filter((invocation) => invocation.triggerSequence <= sequence)
                          .map((invocation) => invocation.id),
                      );
                      const fibers = yield* executor.fenceInvocations(removedIds);
                      return {
                        sequence,
                        value,
                        nextBranchId,
                        nextBranchEpoch,
                        retainedIds,
                        fibers,
                      };
                    }),
                  );
                  if (plan.fibers.length > 0) yield* Fiber.interruptAll(plan.fibers);
                  return yield* dispatchLock.withPermit(
                    Effect.gen(function* () {
                      const state = yield* foldHistorical(plan.sequence, plan.value.facts);
                      const transitioned = yield* journal.continueFrom({
                        sequence: plan.sequence,
                        nextBranchId: plan.nextBranchId,
                        nextBranchEpoch: plan.nextBranchEpoch,
                        renderToken: makeRenderToken(revision + 1, plan.sequence, "live"),
                      });
                      branchId = plan.nextBranchId;
                      branchEpoch = plan.nextBranchEpoch;
                      yield* executor.rebaseInvocations(plan.retainedIds, plan.nextBranchEpoch);
                      latestCommittedByKey.clear();
                      for (const invocation of transitioned.invocations) {
                        if (invocation.concurrencyKey) {
                          latestCommittedByKey.set(invocation.concurrencyKey, invocation.id);
                        }
                      }
                      liveState = state;
                      viewState = state;
                      viewingSequence = plan.sequence;
                      mode = "live";
                      return yield* publish([]);
                    }),
                  );
                }),
              ),
            ),
          (gate) =>
            Effect.gen(function* () {
              yield* dispatchLock.withPermit(
                Effect.sync(() => {
                  if (continuationGate === gate) {
                    continuationGate = undefined;
                    if (!closed) accepting = true;
                  }
                }),
              );
              yield* Deferred.succeed(gate, undefined);
            }),
        ),
      acknowledgeRender: render.acknowledge,
      replayEffect: (request) =>
        schedulerLock.withPermit(
          Effect.gen(function* () {
            const selected = yield* dispatchLock.withPermit(
              Effect.gen(function* () {
                const snapshot = yield* journal.snapshot;
                const invocation = snapshot.invocations.find(
                  (item) => item.id === request.invocationId,
                );
                if (!invocation) {
                  return yield* Effect.fail(
                    new ReplayRejected({
                      code: "unknown-invocation",
                      message: `Unknown effect invocation "${request.invocationId}"`,
                    }),
                  );
                }
                if (invocation.triggerSequence > viewingSequence) {
                  return yield* Effect.fail(
                    new ReplayRejected({
                      code: "not-visible",
                      message: "The invocation is not present at the selected sequence",
                    }),
                  );
                }
                if (renderToken.rendererId !== request.rendererId) {
                  return yield* Effect.fail(
                    new ReplayRejected({
                      code: "render-not-acknowledged",
                      message: `Renderer "${request.rendererId}" does not own the selected render`,
                    }),
                  );
                }
                const validated = validateOutboxInvocation(invocation);
                if (validated._tag === "Invalid") {
                  return yield* Effect.fail(
                    new ReplayRejected({ code: "replay-forbidden", message: validated.detail }),
                  );
                }
                return { invocation: validated.invocation, token: renderToken };
              }),
            );
            return yield* executor.replay({
              invocation: selected.invocation,
              renderToken: selected.token,
              allow: request.allow,
            });
          }),
        ),
      describe: Effect.succeed(description),
      executions: executor.executions,
      executionChanges: executor.changes,
    };

    return runtime;
  });

  return program as Effect.Effect<
    CabRuntime<StateOf<Features>>,
    DefinitionRegistryError | JournalCommitError,
    | Scope.Scope
    | Journal
    | IdGenerator
    | RuntimeClock
    | RenderCoordinator
    | RuntimeSupervisor
    | QueryCache
    | RequirementsOf<Features>
  >;
}
