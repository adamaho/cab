# Cab Effect v4 Runtime — Public API and Execution Design

**Status:** proposed for POC implementation · **Date:** 2026-07-11  
**Inputs:** `06-store-design.md`, `07-poc-brief.md`,
`08-effect-runtime-research.md`, and the current `shells/poc`

## Summary

Cab will use Effect v4 for runtime construction, external services, effect
execution, structured concurrency, cancellation, scheduling, tracing, and
cleanup. The attributed journal remains the source of truth. Solid remains a
rendering adapter.

A command decision may select named side effects, but neither `decide` nor the
fold executes Effect programs:

```text
Intent Command
  → decode and create attributed envelope
  → pure decide(state, args)
  → Decision { events, effects }
  → atomically commit facts + effect invocation records
  → pure fold
  → publish one revision
  → run effects in the runtime Scope
  → dispatch typed outcome commands
  → same loop
```

This design deliberately combines two ideas:

- Foldkit's pure transition returning named Effect-powered work.
- Cab's stricter event sourcing, where immutable facts—not Model snapshots or
  command decisions—are replayed.

Effect is native to the runtime, but not allowed to blur the pure decision and
fold boundaries.

## Desired outcome

After this design is applied to the POC:

1. `refreshTodos` decides both `RefreshRequested` and a `todos.fetch` effect.
2. `scrollToTodo` decides both `TodoScrollRequested` and a
   `todos.scrollTo` effect.
3. Effects use Effect services instead of global `fetch`, `document`, mutable
   cache access, or manual Promise lifecycle tracking.
4. Effects run only after their facts commit and folded state is published.
5. API outcomes return through typed, runtime-only commands.
6. Network effects never execute during scrubbing, replay, remounting, or
   return to Live.
7. Presentation effects execute during replay only when both their definition
   and the user explicitly allow it.
8. Effect Fibers are interrupted on supersession, runtime shutdown, and
   destructive continuation that removes their triggering commit.
9. Devtools connect command → facts → effect executions → outcome facts.
10. Solid components only read folded state, describe screen capabilities,
    dispatch commands, and acknowledge completed renders.

## Normative language

- **MUST** and **MUST NOT** are required.
- **SHOULD** and **SHOULD NOT** are strong recommendations.
- **MAY** is optional.

## Core invariants

1. **One journal.** Every semantic accepted interaction produces facts in one
   totally ordered journal.
2. **Pure decision.** `decide` is synchronous, deterministic, and performs no
   service access, I/O, clock reads, randomness, Fiber creation, or Effect
   execution.
3. **Pure fold.** Refolding facts reconstructs state without running commands,
   validation, effects, subscriptions, or rendering.
4. **Atomic acceptance.** A Decision's facts and effect invocation records are
   committed together or not at all.
5. **No early execution.** No effect Fiber starts before its triggering commit
   succeeds and the complete fact batch folds successfully.
6. **One publication.** Subscribers never observe a partially folded
   multi-fact Decision.
7. **Rejection isolation.** A rejection creates no facts, invocations, effect
   executions, cache writes, or external calls.
8. **Serializable scheduling.** A committed effect invocation contains a
   registered definition identity and serializable arguments, never a closure,
   service, Fiber, or live `Effect` value.
9. **Stable identity.** Command, event, commit, invocation, and branch IDs are
   stable and independent of mutable sequence positions.
10. **Replay purity.** State reconstruction never executes effects.
11. **Double-consent replay.** An effect replays only when its definition
    permits replay and a caller explicitly requests it.
12. **Structured lifetime.** Every effect Fiber belongs to a Scope and runs its
    finalizers when interrupted.
13. **Outcome fencing.** A late, duplicate, superseded, interrupted, or
    abandoned-branch outcome cannot change folded state.
14. **Honest delivery.** Cab promises one logical invocation per accepted
    local commit, not physically exactly-once external execution.
15. **Rendering is an edge.** Solid is not authoritative state and does not
    own domain effects.

## Terminology

### Intent Command

An attributed request from a human, agent, runtime effect, subscription, or
external adapter. Public Intent Commands form the agent action surface.

Examples:

```text
todos.refresh
todos.scrollTo
settings.setTheme
router.navigate
```

### Fact

An immutable event committed to the journal after a command is accepted.
Facts are the only input to historical folding.

Examples:

```text
RefreshRequested
TodoScrollRequested
ThemeChanged
Navigated
```

### Effect Definition

A named description of external work. It declares serializable arguments,
runtime policy, an Effect program, and optional mappings from expected results
to Outcome Commands.

### Effect Invocation

Serializable data selected by `decide`:

```ts
{
  effect: "todos.fetch",
  version: 1,
  args: { requestId: "request-123" }
}
```

The runtime resolves this data against its Effect Definition registry only
after commit.

### Outcome Command

A runtime-only command produced by an effect result. It passes through the same
decode → decide → commit → fold loop as public commands.

Examples:

```text
todos.completeRefresh
todos.failRefresh
```

### Effect Execution

One runtime attempt to execute a committed Effect Invocation. Execution status
is operational telemetry, not folded domain state.

### Feature

A vertical composition unit containing state, events, commands, effects,
reducers, queries, and screen descriptions for one capability.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Rendering adapters                                                   │
│ Solid components · screen registry · browser bindings                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ queries / dispatch / render ack
┌───────────────────────────────▼──────────────────────────────────────┐
│ Cab runtime                                                          │
│ command queue · transaction · fold · subscriptions · scheduler       │
│ Effect Scope · FiberMap/FiberSet · tracing · execution registry       │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │                               │
┌───────────────▼──────────────┐  ┌─────────────▼─────────────────────┐
│ Journal engine              │  │ Effect services                    │
│ facts · invocation outbox   │  │ APIs · cache · viewport · IDs      │
│ keyframes · branches        │  │ clock · telemetry · render coord.  │
└──────────────────────────────┘  └───────────────────────────────────┘
```

The journal engine and effect executor are separate responsibilities. Their
transaction boundary is shared so accepted facts cannot be committed without
their selected effect invocations.

## Public definitions

### Events

```ts
export interface EventDefinition<Name extends string, Args, Encoded = Args> {
  readonly _tag: "EventDefinition";
  readonly name: Name;
  readonly version: number;
  readonly schema: Schema.Schema<Args, Encoded>;
  readonly scope: "global" | "session" | "client";
  readonly retention: "permanent" | "compactable" | "ephemeral";
  readonly render: (args: Args, envelope: FactEnvelope) => string;
  readonly redact?: (args: Args) => Args;
  readonly make: (args: Args) => EventInvocation<Name, Args>;
}

export interface EventInvocation<Name extends string, Args> {
  readonly _tag: "EventInvocation";
  readonly event: Name;
  readonly version: number;
  readonly args: Args;
}

export declare function defineEvent<const Name extends string, Args, Encoded = Args>(
  definition: Omit<EventDefinition<Name, Args, Encoded>, "_tag" | "make">,
): EventDefinition<Name, Args, Encoded>;
```

Event names and versions are immutable once persisted. Redaction occurs before
journal commit. Event constructors are pure.

### Commands

```ts
export type CommandExposure = "public" | "outcome";

export interface CommandDefinition<Name extends string, Args, State> {
  readonly _tag: "CommandDefinition";
  readonly name: Name;
  readonly description: string;
  readonly args: Schema.Schema<Args>;
  readonly exposure: CommandExposure;
  readonly decide: (context: DecideContext<State>, args: Args) => Decision;
  readonly make: (args: Args) => CommandInvocation<Name, Args>;
}

export interface CommandInvocation<Name extends string, Args> {
  readonly _tag: "CommandInvocation";
  readonly command: Name;
  readonly args: Args;
}

export interface DecideContext<State> {
  readonly state: Readonly<State>;
  readonly command: CommandEnvelope;
  readonly query: <A>(query: Query<A>) => A;
}
```

`exposure: "public"` commands appear in screen context and agent tooling.
`exposure: "outcome"` commands are dispatchable only by authorized runtime
origins and are omitted from public command introspection.

Command constructors are pure data constructors. Typed application code uses
them instead of string command names:

```ts
runtime.dispatch(setTheme.make({ theme: "dark" }), actor);
```

Dynamic agent bridges use `dispatchUnknown(name, args, actor)`, which performs
Schema decoding and returns a structured unknown-command rejection.

### Decisions

```ts
export interface CommandRejection {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type Decision =
  | {
      readonly _tag: "Accepted";
      readonly events: readonly [
        EventInvocation<string, unknown>,
        ...EventInvocation<string, unknown>[],
      ];
      readonly effects: readonly EffectInvocation<string, unknown>[];
    }
  | {
      readonly _tag: "Rejected";
      readonly rejection: CommandRejection;
    }
  | {
      readonly _tag: "Noop";
      readonly reason?: string;
    };

export const Decision: {
  readonly accept: (input: {
    readonly events: readonly [
      EventInvocation<string, unknown>,
      ...EventInvocation<string, unknown>[],
    ];
    readonly effects?: readonly EffectInvocation<string, unknown>[];
  }) => Decision;
  readonly reject: (code: string, message: string, details?: unknown) => Decision;
  readonly noop: (reason?: string) => Decision;
};
```

An accepted Decision MUST contain at least one event. Effects therefore always
have a journaled semantic cause. A rejected or no-op Decision schedules no
work.

`Noop` is distinct from rejection. “Already sorted by title” may be an
idempotent no-op; “Todo 40 does not exist” is a rejection.

## Effect definitions

### Policy types

```ts
export type EffectPhase = "after-commit" | "after-render";
export type EffectReplayPolicy = "never" | "manual";
export type EffectAuthority = "client" | "session" | "server";

export type EffectConcurrency<Args> =
  | { readonly _tag: "Every"; readonly limit?: number }
  | {
      readonly _tag: "Latest";
      readonly key: (args: Args) => string;
    }
  | {
      readonly _tag: "Queue";
      readonly key: (args: Args) => string;
      readonly limit?: number;
    };
```

The first POC implementation supports `Every` and keyed `Latest`. `Queue` is
specified now but MAY remain unimplemented until a real workflow requires it.

### Definition and invocation

```ts
export interface EffectDefinition<Name extends string, Args, Success, Failure, Requirements> {
  readonly _tag: "EffectDefinition";
  readonly name: Name;
  readonly version: number;
  readonly description: string;
  readonly args: Schema.Schema<Args>;
  readonly phase: EffectPhase;
  readonly replay: EffectReplayPolicy;
  readonly authority: EffectAuthority;
  readonly concurrency: EffectConcurrency<Args>;
  readonly run: (
    args: Args,
    context: EffectRunContext,
  ) => Effect.Effect<Success, Failure, Requirements>;
  readonly onSuccess?: (
    value: Success,
    args: Args,
    context: EffectRunContext,
  ) => CommandInvocation<string, unknown> | void;
  readonly onFailure?: (
    error: Failure,
    args: Args,
    context: EffectRunContext,
  ) => CommandInvocation<string, unknown> | void;
  readonly make: (args: Args) => EffectInvocation<Name, Args>;
}

export interface EffectInvocation<Name extends string, Args> {
  readonly _tag: "EffectInvocation";
  readonly effect: Name;
  readonly version: number;
  readonly args: Args;
}

export interface EffectRunContext {
  readonly executionId: string;
  readonly invocationId: string;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly actor: Actor;
  readonly mode: "live" | "manual-replay";
  readonly attempt: number;
  readonly ensureCurrent: Effect.Effect<void, StaleExecution>;
}
```

Calling `effect.make(args)` performs no I/O and constructs no Effect program.
It returns serializable invocation data. `run` is called only by the executor
after resolving the committed invocation against the definition registry.

Expected failures use the typed error channel and `onFailure`. Defects bypass
`onFailure`, are reported to the runtime supervisor, and appear as defect
telemetry. Interruption is not failure and does not produce a failure command
unless a feature explicitly models cancellation. `StaleExecution` is a
runtime-owned control error: the executor records it as stale and suppresses
both outcome mappings. Effects SHOULD call `ensureCurrent` immediately before
publishing cache data or other locally staged results after a long external
operation.

### Example: API request

```ts
const refreshTodos = defineCommand({
  name: "todos.refresh",
  description: "Request fresh todos",
  args: Schema.Struct({}),
  exposure: "public",

  decide: (context) => {
    if (context.state.todos.loading) {
      return Decision.reject("todos.refresh.already-running", "A refresh is already running");
    }

    const requestId = context.command.id;

    return Decision.accept({
      events: [RefreshRequested.make({ requestId })],
      effects: [FetchTodos.make({ requestId })],
    });
  },
});

const FetchTodos = defineEffect({
  name: "todos.fetch",
  version: 1,
  description: "Fetch todos and cache the content-addressed payload",
  args: Schema.Struct({ requestId: Schema.String }),
  phase: "after-commit",
  replay: "never",
  authority: "client",
  concurrency: {
    _tag: "Latest",
    key: () => "todos.refresh",
  },

  run: ({ requestId }, context) =>
    Effect.gen(function* () {
      const api = yield* TodoApi;
      const cache = yield* TodoCache;
      const todos = yield* api.list();
      yield* context.ensureCurrent;
      const requestHash = yield* cache.put(todos);
      return { requestId, requestHash, count: todos.length };
    }),

  onSuccess: ({ requestId, requestHash, count }) =>
    completeTodosRefresh.make({ requestId, requestHash, count }),

  onFailure: (error, { requestId }) => failTodosRefresh.make({ requestId, message: error.message }),
});
```

The outcome commands validate that `requestId` is still active and that the
invocation lease remains valid. Payloads stay outside the journal.

### Example: browser presentation work

```ts
const scrollToTodo = defineCommand({
  name: "todos.scrollTo",
  description: "Scroll a visible todo into view",
  args: Schema.Struct({ id: Schema.Number }),
  exposure: "public",

  decide: (context, { id }) => {
    const target = context.query(todos.targetById(id));
    if (target._tag === "Missing") {
      return Decision.reject("todos.scroll.missing", `Todo ${id} does not exist`);
    }
    if (target.page !== context.state.todos.page) {
      return Decision.reject(
        "todos.scroll.off-page",
        `Todo ${id} is on page ${target.page}; navigate there first`,
      );
    }

    return Decision.accept({
      events: [TodoScrollRequested.make({ id })],
      effects: [ScrollToTodo.make({ id })],
    });
  },
});

const ScrollToTodo = defineEffect({
  name: "todos.scrollToAnchor",
  version: 1,
  description: "Bring a semantic todo anchor into the viewport",
  args: Schema.Struct({ id: Schema.Number }),
  phase: "after-render",
  replay: "manual",
  authority: "session",
  concurrency: {
    _tag: "Latest",
    key: () => "todos.viewport",
  },
  run: ({ id }, context) =>
    Effect.gen(function* () {
      const viewport = yield* Viewport;
      yield* viewport.scrollTo(`#todo-${id}`, {
        behavior: context.mode === "live" ? "smooth" : "auto",
        block: "center",
      });
    }),
});
```

Switching pages and returning does not rerun the command or effect. Manual
replay is a distinct runtime operation.

## Envelopes and causation

### Actor

```ts
export interface Actor {
  readonly kind: "human" | "agent" | "system" | "external";
  readonly id: string;
}
```

### Command envelope

```ts
export interface CommandEnvelope {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly actor: Actor;
  readonly issuedAt: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly origin:
    | { readonly _tag: "Actor" }
    | { readonly _tag: "Effect"; readonly executionId: string }
    | { readonly _tag: "Subscription"; readonly subscriptionId: string }
    | { readonly _tag: "External"; readonly adapterId: string };
}
```

A root command uses its own ID as `correlationId`. Outcome Commands inherit
the initiating actor and correlation ID while identifying the runtime Effect
execution as their origin. This preserves “Agent bot caused the refresh”
without pretending the agent directly produced the HTTP response.

### Commit and facts

```ts
export interface CommitEnvelope {
  readonly id: string;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly commandId: string;
  readonly correlationId: string;
  readonly committedAt: number;
}

export interface Fact {
  readonly id: string;
  readonly sequence: number;
  readonly name: string;
  readonly version: number;
  readonly args: unknown;
  readonly actor: Actor;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly at: number;
}
```

Sequences order facts but do not identify them. Request correlation and stale
outcome validation use stable IDs, never sequence numbers.

## Atomic journal and effect outbox

An accepted Decision produces one transaction:

```ts
export interface CommitRequest {
  readonly command: CommandEnvelope;
  readonly events: readonly EventInvocation<string, unknown>[];
  readonly effects: readonly EffectInvocation<string, unknown>[];
}

export interface CommittedEffectInvocation {
  readonly id: string;
  readonly definition: string;
  readonly version: number;
  readonly args: unknown;
  readonly ordinal: number;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly phase: EffectPhase;
  readonly replay: EffectReplayPolicy;
  readonly authority: EffectAuthority;
  readonly status: "pending" | "claimed" | "terminal" | "cancelled";
}
```

Facts and `CommittedEffectInvocation` records MUST be persisted atomically.
This is a transactional outbox. It closes the crash window where facts commit
but the process dies before scheduling their work.

The in-memory POC implements this with one synchronous critical section over
immutable arrays. A durable engine must provide an actual atomic transaction.

Effect invocation IDs are derived from stable command ID, effect ordinal, and
definition version. Retries reuse the same invocation and external idempotency
key.

## Runtime API

### Construction

```ts
export declare function createRuntime<
  const Features extends readonly Feature<string, unknown, unknown>[],
>(config: {
  readonly features: Features;
  readonly keyframes?: KeyframePolicy;
}): Effect.Effect<
  CabRuntime<StateOf<Features>>,
  RuntimeInitError | JournalOpenError,
  Scope.Scope | RequirementsOf<Features>
>;
```

Canonical startup is scoped:

```ts
const program = Effect.gen(function* () {
  const runtime = yield* createRuntime({
    features: [routerFeature, settingsFeature, todosFeature],
  });

  yield* launchSolid(runtime);
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      JournalMemoryLive,
      TodoApiLive,
      TodoCacheLive,
      ViewportBrowserLive,
      RenderCoordinatorLive,
      RuntimeSupervisorLive,
    ),
  ),
  Effect.scoped,
);
```

The runtime Scope owns the command worker, effect executor, render scheduler,
subscriptions, resource Layers, and all child Fibers.

### Dispatch

```ts
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
  | {
      readonly _tag: "Noop";
      readonly command: CommandEnvelope;
      readonly reason?: string;
    };

export interface CabRuntime<State> {
  readonly dispatch: <Name extends string, Args>(
    invocation: CommandInvocation<Name, Args>,
    actor: Actor,
  ) => Effect.Effect<DispatchResult, JournalCommitError>;

  readonly dispatchUnknown: (
    name: string,
    args: unknown,
    actor: Actor,
  ) => Effect.Effect<DispatchResult, JournalCommitError>;

  readonly snapshot: Effect.Effect<RuntimeSnapshot<State>>;
  readonly changes: Stream.Stream<RuntimeRevision<State>>;
  readonly stateAt: (sequence: number) => Effect.Effect<HistoricalSnapshot<State>, HistoryError>;
  readonly describe: Effect.Effect<RuntimeDescription>;
}
```

Typed code cannot construct an unknown command. Unknown dynamic input is a
structured rejection. Journal/storage defects remain in the Effect error
channel; domain rejection remains data.

`dispatch` returns after facts are committed, folded state is published, and
effects are durably pending/scheduled. It does not await effect completion.

### Dispatch ordering

The runtime MUST execute one dispatch through these phases:

1. Allocate command ID and envelope using runtime ID and Clock services.
2. Decode command arguments.
3. Serialize through the command queue or critical section.
4. Read the live head and run pure `decide`.
5. Decode effect arguments and decode/redact event arguments.
6. Tentatively fold the complete event batch.
7. Atomically append facts and effect invocation records.
8. Install the tentatively folded state.
9. Publish one journal/state revision.
10. Release the dispatch critical section.
11. Make `after-commit` invocations eligible for execution.
12. Make `after-render` invocations wait for the matching render token.
13. Return `DispatchResult.Accepted`.

Effect Fibers MUST NOT start while the dispatch lock is held. This prevents an
immediate outcome from reentering a partially committed dispatch.

## Effect execution

### Structured concurrency

- `FiberSet` owns `Every` executions.
- `FiberMap` owns keyed `Latest` executions and interrupts the prior Fiber for
  the same key.
- A scoped keyed queue will own `Queue` workers when implemented.
- Closing the runtime Scope interrupts all executions and runs finalizers.
- Effect interruption records telemetry but does not dispatch failure.

Each execution carries a lease containing invocation ID, branch epoch, and
concurrency generation. Before dispatching an outcome, the executor verifies
that the lease is still current. This protects against external work that
ignores interruption and completes late.

### Retry and idempotency

The initial POC does not implement automatic retries. The definition shape is
reserved for a later policy:

```ts
export interface EffectRetryPolicy<Failure> {
  readonly schedule: Schedule.Schedule<unknown, Failure>;
  readonly while: (failure: Failure) => boolean;
  readonly timeout?: Duration.Duration;
  readonly maxAttempts: number;
}
```

When retries are introduced:

- all attempts reuse one invocation ID and idempotency key;
- defects and interruptions do not retry by default;
- expected failures are classified explicitly;
- only one semantic outcome may commit;
- API mutations require server-supported idempotency where available.

Cab MUST NOT claim exactly-once external execution. It can provide at-least-once
attempts plus logical deduplication of outcomes.

### Expected failures, defects, and interruption

```text
Typed Failure
  → onFailure
  → Outcome Command
  → journaled failure fact

Defect
  → supervisor
  → telemetry/crash policy
  → no fabricated domain fact

Interruption
  → finalizers
  → interrupted telemetry
  → no failure fact by default
```

An Effect with a non-`never` expected failure SHOULD define `onFailure` unless
silent operational failure is an explicit documented choice.

## Rendering coordination

DOM effects need an explicit post-render barrier. A microtask is not a
rendering contract.

```ts
export interface RenderToken {
  readonly rendererId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly mode: "live" | "historical";
}

export interface RenderCoordinator {
  readonly published: Stream.Stream<RenderToken>;
  readonly acknowledge: (token: RenderToken) => Effect.Effect<void>;
  readonly await: (token: RenderToken) => Effect.Effect<void>;
}
```

Every live commit, scrub, return to Live, or branch continuation publishes a
monotonic render revision. The Solid adapter renders that revision and
acknowledges after its DOM commit. `after-render` effects wait for the exact
triggering revision.

If a newer render supersedes an unacknowledged token, pending presentation
work for the old token is interrupted or marked stale. This prevents stale
scroll and focus effects after navigation.

The first implementation supports one renderer. Multi-window rendering will
require renderer-specific effect authority and acknowledgement.

## Solid adapter

The canonical runtime API remains Effect-native. The Solid adapter owns a
`ManagedRuntime`-style bridge for event handlers and cleanup:

```ts
export interface SolidCabHandle<State> {
  readonly state: Accessor<State>;
  readonly journal: Accessor<readonly Fact[]>;
  readonly sequence: Accessor<number>;
  readonly dispatch: <Name extends string, Args>(
    command: CommandInvocation<Name, Args>,
    actor?: Actor,
  ) => void;
  readonly dispatchEffect: <Name extends string, Args>(
    command: CommandInvocation<Name, Args>,
    actor?: Actor,
  ) => Effect.Effect<DispatchResult, JournalCommitError>;
}
```

The convenience `dispatch` starts the Effect inside the runtime Scope and
routes defects to the supervisor. Agent bridges and workflows use
`dispatchEffect` so they can await acceptance.

Solid components MUST NOT acquire API clients or run domain Effects directly.
They MAY dispatch commands and register mounted screen capabilities.

## Feature composition

```ts
export interface Feature<Name extends string, State, Requirements> {
  readonly _tag: "Feature";
  readonly name: Name;
  readonly initialState: State;
  readonly events: readonly EventDefinition<string, unknown>[];
  readonly commands: readonly CommandDefinition<string, unknown, State>[];
  readonly effects: readonly EffectDefinition<string, unknown, unknown, unknown, Requirements>[];
  readonly reduce: (state: State, fact: Fact) => State;
  readonly screen?: ScreenDefinition<State>;
}

export declare function defineFeature<const Name extends string, State, Requirements>(
  definition: Omit<Feature<Name, State, Requirements>, "_tag">,
): Feature<Name, State, Requirements>;
```

Features are vertical:

```text
features/todos/
  events.ts
  commands.ts
  effects.ts
  fold.ts
  queries.ts
  screen.ts
  services.ts
  feature.ts
  test/
```

All feature reducers observe the same ordered facts and return unchanged state
for irrelevant facts. `createRuntime` rejects duplicate feature, event,
command, and effect names before acquiring resources.

Cross-feature workflows use commands and facts, not direct mutation of another
feature's state.

## Services and Layers

External capabilities are Effect services:

```ts
export class TodoApi extends Context.Service<
  TodoApi,
  {
    readonly list: () => Effect.Effect<readonly Todo[], TodoApiError>;
  }
>()("cab/TodoApi") {}

export class TodoCache extends Context.Service<
  TodoCache,
  {
    readonly put: (todos: readonly Todo[]) => Effect.Effect<string, CacheError>;
    readonly get: (hash: string) => Effect.Effect<Option.Option<readonly Todo[]>, CacheError>;
  }
>()("cab/TodoCache") {}

export class Viewport extends Context.Service<
  Viewport,
  {
    readonly scrollTo: (
      anchor: string,
      options: ScrollOptions,
    ) => Effect.Effect<void, TargetNotMounted>;
  }
>()("cab/Viewport") {}
```

Production supplies live Layers. Tests supply deterministic Layers. Effect
definitions depend on service interfaces, not global APIs.

Application-lifetime services are built once in the runtime Scope. Model- or
screen-scoped managed resources and Streams are deferred until a second real
use case proves the abstraction.

## Screen context

Screen descriptions expose only public commands relevant to the current
folded screen. They may also describe the effects a command can schedule, but
agents cannot dispatch effect definitions directly.

```ts
export interface ScreenCommandDescription {
  readonly command: string;
  readonly description: string;
  readonly argsSchema: object;
  readonly possibleEffects: readonly {
    readonly name: string;
    readonly phase: EffectPhase;
    readonly replay: EffectReplayPolicy;
  }[];
}
```

Historical screen context is derived from historical folded state and journal
metadata. It does not acquire services or execute effects.

## Replay and theatre mode

### State replay

`stateAt(sequence)` loads a keyframe and folds facts forward. It never runs
`decide`, effect definitions, Outcome Commands, subscriptions, or API calls.

### Manual effect replay

Manual effect replay operates on committed invocation records, not inferred
event names:

```ts
export interface ReplayRequest {
  readonly invocationId: string;
  readonly rendererId: string;
}

export interface EffectReplay {
  readonly replay: (request: ReplayRequest) => Effect.Effect<ReplayResult, ReplayRejected>;
}
```

The runtime verifies:

1. the invocation exists at the selected sequence;
2. its definition version is registered;
3. `replay === "manual"`;
4. the user explicitly enabled replay;
5. the historical render token was acknowledged;
6. the replay Scope has only permitted services.

Replay executions receive a distinct execution ID, suppress `onSuccess` and
`onFailure`, and cannot dispatch Outcome Commands. API, analytics, clipboard,
notification, and write services are absent from the replay Layer.

The POC may keep invocation records in memory. Production replay across
restarts requires durable invocation sidecar storage.

## Branching and destructive continuation

Production shared history is append-only. The POC's “Continue from here” is a
devtools branch operation even if its old branch is currently discarded.

```ts
export interface BranchContinuation {
  readonly fromSequence: number;
  readonly previousBranchId: string;
  readonly nextBranchId: string;
  readonly nextBranchEpoch: number;
}
```

Before continuation completes, the runtime MUST:

1. stop accepting dispatches on the old live head;
2. interrupt running and queued invocations triggered by removed commits;
3. await their finalizers;
4. cancel pending outbox records from the removed future;
5. increment branch identity/epoch;
6. fold and publish the selected state;
7. acknowledge that already completed external work is not undone;
8. reopen dispatch at the new head.

Late outcomes from an abandoned branch fail lease validation even if sequence
numbers are reused.

## Future multiplayer authority

Effect Definitions declare execution authority:

- `client`: local UI and local cache effects.
- `session`: one designated session executor.
- `server`: global irreversible work.

When sync exists, irreversible global effects MUST wait until triggering facts
are confirmed. Competing executors require leases and fencing tokens. Outcome
facts preserve both initiating actor and authenticated executor origin.

The POC runs all current effects locally, but the authority field is included
now so effect placement is explicit.

## Effect execution telemetry

```ts
export interface EffectExecution {
  readonly id: string;
  readonly invocationId: string;
  readonly effect: string;
  readonly version: number;
  readonly args: unknown;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly actor: Actor;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly phase: EffectPhase;
  readonly mode: "live" | "manual-replay";
  readonly concurrencyKey?: string;
  readonly attempt: number;
  readonly status:
    | "pending"
    | "awaiting-render"
    | "running"
    | "outcome-dispatched"
    | "succeeded"
    | "failed"
    | "interrupted"
    | "stale"
    | "defect";
  readonly startedAt?: number;
  readonly endedAt?: number;
}
```

Telemetry is separate from semantic facts. It may be bounded and ephemeral,
while pending invocation records needed for crash recovery are durable.

Effect runs use spans named after the definition and include redacted command,
commit, invocation, execution, actor, correlation, phase, and concurrency
attributes.

## Devtools design

The POC devtools gains an **Effects** tab.

For each command dispatch it shows:

```text
todos.refresh · Human adam
├─ fact #42 RefreshRequested
└─ effect todos.fetch
   ├─ pending
   ├─ running · 134 ms
   └─ outcome todos.completeRefresh
      └─ fact #43 RefreshCompleted
```

The tab provides:

- registered Effect Definitions and policies;
- pending/running/terminal executions;
- causation and correlation IDs;
- interruption, stale outcome, and defect states;
- explicit replay control only for `manual` definitions;
- no direct button for agents to bypass command decisions and run effects.

The journal timeline remains semantic history. It does not fill with scheduler
status records.

## Error model

```ts
export type DispatchError = JournalCommitError | RuntimeClosedError | DefinitionRegistryError;
```

Domain rejection is `DispatchResult.Rejected`, not an Effect failure.

Expected external errors are typed Effect failures and normally map to Outcome
Commands. Defects are supervised. A subscriber defect cannot roll back an
already committed transaction or duplicate effect scheduling.

Unknown public commands return structured rejection from `dispatchUnknown`.
Duplicate definition names fail runtime startup.

## Performance boundary

Effect is native around dispatch orchestration, but the inner correctness
functions remain plain TypeScript:

```text
Effect-managed:
IDs and Clock → command queue → durable transaction → executor → services
→ Fibers → cancellation → tracing → resources → shutdown

Plain synchronous:
decode result consumption → decide → validate proposals → tentative fold
```

The runtime MUST NOT call `Effect.runSync`, acquire services, fork Fibers, or
construct Effect programs per reduced fact inside `decide` or `reduce`.

Effect Invocation descriptors are plain serializable data. The executor
constructs the actual Effect only after claiming a committed invocation.

Benchmark gates:

- no-effect micro-interaction dispatch SHOULD remain below the existing
  sub-millisecond warmed p99 target on the reference machine;
- runtime infrastructure SHOULD add no more than an agreed relative overhead
  budget to the same workload;
- effect execution happens outside the dispatch critical section.

## Testing design

### Decision tests

- accepted events and effect invocation descriptors;
- rejection and no-op schedule nothing;
- public/outcome authorization;
- command arguments and effect arguments decode;
- decision purity.

### Fold tests

- every journal prefix refolds deterministically;
- multi-fact Decisions fold atomically;
- effect invocation records do not influence folded state;
- unknown facts fail loudly;
- structured-clone round trips.

### Effect definition tests

- test Layers drive success and expected failure;
- result mapping produces the correct Outcome Command;
- defects reach the supervisor;
- interruption runs finalizers and produces no failure command;
- no global browser or network APIs are used directly.

### Runtime tests

- commit → fold → publish → effect ordering;
- crash/failure injection produces no partial facts or invocations;
- rejection/no-op starts zero Fibers;
- keyed Latest interrupts prior work;
- stale and duplicate outcomes are rejected;
- runtime Scope disposal interrupts all work;
- actor, origin, causation, and correlation propagate;
- after-render work waits for the exact render acknowledgement;
- branch continuation interrupts removed work before reopening dispatch;
- replay has restricted services and suppresses outcomes.

Use Effect `Deferred`, `Ref`, test services, and `@effect/vitest` instead of
`setTimeout(0)` timing.

### Browser component tests

- loading, success, and failure rendering;
- repeated refresh and latest-wins behavior;
- semantic scroll runs after DOM acknowledgement;
- unrelated commands and remounts do not rerun scroll;
- normal scrubbing never calls APIs or effects;
- explicit viewport replay runs only the selected invocation;
- rapid scrub interrupts superseded viewport replay;
- devtools effects trace links through outcome facts;
- screen context advertises commands and possible effects.

## POC migration plan

### Slice 1 — Definitions and Decision

Add:

```text
shells/poc/src/runtime/definition.ts
shells/poc/src/runtime/decision.ts
shells/poc/src/runtime/feature.ts
```

Convert existing events, commands, and reducers to definitions. Make decisions
return `{ events, effects }`, but keep the current executor temporarily.

**Acceptance gate:** all existing user-visible behavior and tests remain green;
rejected commands produce no effect descriptors.

### Slice 2 — Effect services

Add Effect services and Layers for:

```text
TodoApi
TodoCache
Viewport
IdGenerator
RenderCoordinator
RuntimeSupervisor
```

Remove direct global `fetch`, `document`, and mutable cache access from effect
implementations.

**Acceptance gate:** effect tests run entirely with test Layers.

### Slice 3 — Effect Scope and executor

Replace `startEffectRunner` with the scoped executor. Add in-memory atomic fact
and invocation commit, `FiberSet`, keyed `FiberMap`, execution leases, and
telemetry.

**Acceptance gate:** commit ordering, Latest interruption, stale outcome, and
Scope shutdown tests pass.

### Slice 4 — Solid render acknowledgement

Create the Solid adapter's stable runtime handle and revision acknowledgement.
Move scroll to `after-render` scheduling.

**Acceptance gate:** Playwright component tests prove no remount scroll and no
microtask race.

### Slice 5 — Outcome commands and causation

Make refresh completion/failure explicit runtime-only Outcome Commands. Replace
`requestSequence` with stable request/invocation IDs and add actor/origin/
correlation metadata.

**Acceptance gate:** duplicate, stale, and abandoned-branch outcomes append no
facts.

### Slice 6 — Devtools effects view

Add definitions, execution lifecycle, correlation chain, and explicit manual
replay by invocation ID.

**Acceptance gate:** a user can inspect command → facts → effect → outcome
without mixing scheduler telemetry into the journal.

### Slice 7 — Vertical feature bundles

Split router, settings, todos, and ingest into `defineFeature` bundles and
compose them in `createRuntime`.

**Acceptance gate:** duplicate names fail startup; each feature can be tested
with only its required test Layers.

### Slice 8 — Branch-safe continuation

Add branch IDs/epochs, execution interruption, invocation cancellation, and
late-outcome fencing to “Continue from here.”

**Acceptance gate:** a removed effect cannot later update cache, DOM, journal,
or folded state even if its external operation ignores interruption.

## Changes to earlier documents

This design intentionally supersedes two earlier constraints:

1. `07-poc-brief.md` says to use Effect Schema only and keep Effect runtime out
   of the store hot path. This design adopts Effect for orchestration while
   retaining plain synchronous `decide` and fold internals.
2. `06-store-design.md` requires append-only production history, while the POC
   now supports destructive continuation. This design classifies continuation
   as a devtools branch operation and requires branch fencing.

The original mission remains unchanged: one attributed journal, deterministic
historical state, agent-readable commands and screens, and a multiplayer-ready
interface substrate.

## Deferred work

The first POC migration does not include:

- durable browser outbox recovery across reloads;
- automatic retries and backoff;
- server effect executors or multiplayer leases;
- model-driven Subscriptions;
- ManagedResources;
- multiple renderers;
- production keyframe persistence;
- global compensation workflows.

The API leaves room for these without requiring their implementation now.

## Decision summary

Adopt the following direction:

1. Commands remain attributed, public intent—not Foldkit-style names for side
   effects.
2. Pure decisions return facts plus serializable named Effect Invocations.
3. Facts and invocations commit atomically.
4. The Effect runtime resolves invocations after commit and executes them in a
   supervised Scope.
5. Effect outcomes return through runtime-only commands.
6. Solid is a rendering adapter with an explicit render acknowledgement.
7. Historical state is always fold-only.
8. Safe presentation replay is explicit, invocation-based, and restricted.
9. Effect execution telemetry is observable but separate from semantic facts.
10. Vertical features compose into one runtime and one globally ordered
    journal.

This is the design to use for the next POC implementation pass.
