# Cab Effect Runtime Research — Foldkit and Remix v3

**Status:** research and recommended direction · **Date:** 2026-07-11  
**Inputs:** `06-store-design.md`, `07-poc-brief.md`, the current `shells/poc`, Foldkit, and Remix v3

## Executive summary

Cab should adopt Effect v4 as the runtime beneath commands, event commits,
side-effect execution, subscriptions, resources, tracing, cancellation, and
lifecycle management. Solid should remain a rendering adapter at the edge.

The recommended loop is:

```text
Actor dispatches Intent Command
             │
             ▼
      pure decide(state, args)
             │
             ▼
 Decision { events, effects }
             │
       commit events atomically
             │
       fold durable state
             │
       publish subscriptions ───────────────► Solid render
             │
       fork named Effect programs
             │
       outcome command/event
             └──────────────────────────────► same loop
```

The key design choice is that `decide` may **describe** lazy Effect programs,
but it must never execute them. Effects run only after their triggering events
have committed successfully. Historical replay folds recorded events and does
not reconstruct or execute effects unless a caller explicitly requests an
allowed replay policy.

This borrows Foldkit's strongest idea—an update step can return named Effect
commands—while retaining Cab's stronger event-sourcing model. Foldkit records
Messages and Model transitions for devtools, but its `update` directly returns
the next Model and replay may rerun `update`. Cab instead treats committed
facts as the durable source of truth and requires replay to run only the pure
fold.

Remix v3 is not an event-sourcing model. Its useful lessons are elsewhere:
typed event boundaries, abortable reentry, scoped lifecycle composition,
separate update/commit/post-commit phases, and explicit render/frame ownership.
Those ideas fit naturally inside an Effect runtime, but Remix's DOM event bus
should not become Cab's journal or command bus.

## Research snapshot

### Foldkit

- Repository: <https://github.com/foldkit/foldkit>
- Inspected commit: `9b6d47a71a6d3077abb0dbe2216cf33b681eb4dc`
- Package version at that commit: `foldkit@0.127.0`
- Effect peer version: `4.0.0-beta.88`
- Primary architecture page: <https://foldkit.dev/core/architecture>
- Primary source:
  - `packages/website/src/page/core/architecture.ts`
  - `packages/foldkit/src/command/index.ts`
  - `packages/foldkit/src/runtime/runtime.ts`
  - `examples/api-cache/src/main.ts`
  - `examples/todo/src/main.ts`

### Remix v3

- Repository: <https://github.com/remix-run/remix>
- Inspected `main` commit:
  `b2ef0fc1696e8ab55ba305e435eb8bf6210a99c1`
- `packages/remix` version at that commit: `3.0.0-beta.5`
- Relevant source and documentation:
  - `packages/ui/src/runtime/typed-event-target.ts`
  - `packages/ui/src/runtime/event-listeners.ts`
  - `packages/ui/src/runtime/mixins/on-mixin.ts`
  - `packages/ui/src/runtime/mixins/mixin.ts`
  - `packages/ui/src/runtime/component.ts`
  - `packages/ui/src/runtime/frame.ts`
  - `packages/ui/src/runtime/scheduler.ts`
  - `packages/ui/src/runtime/vdom.ts`
  - `packages/ui/docs/component.md`
  - `packages/ui/docs/events.md`
  - `packages/ui/docs/context.md`
  - `packages/ui/docs/handle.md`

Both projects are moving quickly. The commit hashes above matter more than a
floating version description.

## Foldkit findings

### 1. Its core is Elm architecture expressed through Effect

Foldkit describes one loop:

```text
Message
  → update(Model, Message)
  → [next Model, Command<Message>[]]
  → render next Model
  → runtime executes Commands
  → Command results become Messages
  → update again
```

A Foldkit `Command` is explicitly a named, one-shot side effect:

```ts
type Command<Message, Error, Requirements> = {
  readonly name: string;
  readonly args?: Record<string, unknown>;
  readonly effect: Effect.Effect<Message, Error, Requirements>;
};
```

`Command.define` binds a name, optional argument Schema, possible result
Message Schemas, and an Effect program. The command is lazy data until the
runtime executes it.

An API request therefore looks roughly like:

```ts
const FetchPost = Command.define(
  "FetchPost",
  { postId: Schema.String },
  SettledFetchPost,
)(({ postId }) =>
  Effect.gen(function* () {
    const post = yield* Posts.get(postId);
    return SettledFetchPost({ postId, post });
  }),
);
```

The pure update function chooses whether to return `FetchPost(...)`. The
runtime forks its Effect and routes the resulting Message back through
`update`.

### 2. Services and lifecycles are first-class

Foldkit distinguishes several kinds of external work:

- **Command:** one-shot Effect that returns a Message.
- **Subscription:** scoped Stream driven by a Model projection.
- **Mount:** Effect or Stream tied to a concrete mounted element.
- **Resource:** application-lifetime dependency supplied through a Layer.
- **ManagedResource:** dependency acquired and released according to Model
  state.
- **Port:** Schema-validated boundary between a Foldkit runtime and its host.

The runtime builds shared resource Layers once, provides them to Commands and
Subscriptions, and releases them at teardown. This is a strong fit for API
clients, analytics, WebSockets, workers, and browser capability services.

### 3. Command composition preserves metadata

Foldkit has `Command.mapMessage`, `mapMessages`, and `mapEffect`. Child
submodels return Commands in their own Message type; parents lift the result
Messages without losing command name or argument metadata.

This matters beyond type convenience. Foldkit's Story and Scene tests can
resolve a command with a substitute result without executing the real Effect.
The mapping chain is retained as metadata specifically so tests and devtools
observe the same composition as production.

Cab should preserve the same property: named effect descriptions and their
result mapping must remain inspectable without running external work.

### 4. Runtime execution is scoped, traced, and concurrent

For every command returned by `update`, Foldkit's runtime:

1. wraps the Effect in a span named after the command;
2. records command arguments as span attributes;
3. provides shared resources;
4. forks it into the runtime Scope;
5. enqueues its resulting Message;
6. routes unhandled failure into crash handling.

This is a useful default mechanism. Cab will need additional policies such as
`latest`, `keyed`, or `queue`, but should build those on Effect Fibers, Scope,
and interruption instead of inventing promise bookkeeping.

### 5. Its devtools are close to theatre mode, but the replay contract differs

Foldkit records Messages, before/after Models, emitted Commands, changed paths,
and periodic keyframes. It can pause, jump to a historical point, and resume.
During replay rendering it substitutes a no-op dispatch so mount-derived
Messages do not pollute history.

However, Foldkit is not event-sourced in Cab's strict sense:

- `update` directly computes the next Model.
- Messages are inputs to update, not immutable domain facts with a separate
  pure fold.
- Historical reconstruction may replay `update` from a keyframe.
- Commands are consequences of update and are not rerun during normal
  devtools reconstruction.

Cab must not collapse `decide` and `fold` into Foldkit's `update`. Doing so
would make command validation part of replay and weaken deterministic journal
semantics.

### 6. What Cab should borrow from Foldkit

- Named lazy Effect values returned from a pure decision step.
- Effect result values feeding back into the same command/event loop.
- Layer-provided application services.
- Scope-owned Fibers and cleanup.
- Model-driven subscriptions and managed resources.
- Effect metadata visible to tests, traces, and devtools.
- Feature/submodel composition that maps child outcomes to parent outcomes.
- Separate tests for pure transitions, effect resolution, and rendered scenes.

### 7. What Cab should not copy directly

- Calling both user intent and side effects “Command.” Cab already uses
  command for attributed external intent.
- Replaying the decision/update function to reconstruct durable state.
- Treating before/after Model snapshots as the durable history.
- Letting an unhandled effect defect silently become a domain failure event.
  Defects and expected failures need separate handling.

## Remix v3 findings

### 1. Remix v3's UI event system is typed DOM infrastructure

The current v3 beta UI package wraps `EventTarget` with typed event maps and
provides helpers for adding typed listener records. This is useful for local
runtime and lifecycle communication, but it is neither durable nor ordered
like Cab's journal.

Cab can use typed event targets internally for adapter notifications, but an
`EventTarget` must not become the source of truth for commands or facts.

### 2. Event reentry is explicitly abortable

Remix's `on()` mixin keeps an `AbortController` for the current handler. When
the same handler is entered again, it aborts the previous invocation with an
`EventReentry` reason and gives the new handler a fresh signal.

This is a concrete concurrency policy equivalent to “latest wins.” Cab should
express the same behavior through Effect Fiber interruption:

```text
effect policy: latest, keyed by command/effect instance
```

Effect gives Cab structured interruption, finalizers, and typed requirements
rather than manually threading `AbortController` through every service. HTTP
services can still bridge Fiber interruption to an `AbortSignal` at the fetch
boundary.

### 3. Remix separates update, commit, and post-commit work

The Remix scheduler maintains distinct queues for update, commit, and
post-commit tasks. Components can request an update and queue work that must
run after rendering.

Cab needs a similar phase model:

```text
validate → commit journal → fold signals → render notification → effects
```

Some effects may require the DOM produced by the fold, such as scroll or
focus. These should run in a named `after-render` phase, not depend on an
accidental microtask race.

### 4. Mixins and frames own lifecycle scopes

Remix mixins expose insert, update, commit, reclaim, and removal lifecycle
signals. Frames are explicit rendering/reload islands with cancellation and
state-preservation behavior.

Cab should borrow the ownership principle rather than the exact mixin API:

- application runtime owns app-lifetime resources;
- feature or screen Scope owns screen-lifetime subscriptions;
- mounted capability owns DOM-lifetime effects;
- leaving a scope interrupts its Fibers and runs finalizers.

This is particularly useful for screen context. A capability should disappear
and its screen-scoped work should be interrupted when its owner unmounts.

### 5. Remix keeps setup state separate from rerender work

A component setup runs once; a returned render function runs on update. Stable
handles expose context, cancellation signals, frame access, and task queues.

Solid already provides the rendering mechanics Cab needs. The transferable
lesson is that Cab's runtime handle should be stable and lifecycle-owned while
state snapshots remain reactive inputs.

### 6. What Cab should borrow from Remix

- Abort/reentry semantics as named concurrency policies.
- Explicit update/commit/after-render scheduling phases.
- Scope ownership and deterministic cleanup.
- Typed local event boundaries.
- Stable runtime handles supplied through rendering context.
- Test helpers that flush scheduled work and verify disposal.

### 7. What Cab should not borrow

- DOM event propagation as application state history.
- Component-local lifecycle events in the durable journal by default.
- A global event bus that bypasses command validation and attribution.
- Frame-specific rendering architecture for the initial store runtime.

## Proposed Cab model

### Terminology

To avoid Foldkit's naming collision:

- **Intent Command:** attributed request from a human, agent, runtime, or
  external adapter. It is validated by `decide`.
- **Fact:** immutable committed event in the journal.
- **Effect:** named lazy Effect program selected by a successful decision.
- **Outcome Command:** command dispatched by an Effect when external work
  succeeds or fails.
- **Service:** typed dependency supplied through an Effect Layer.
- **Subscription:** scoped Stream that may dispatch Commands.

### Decision API

A command should return a declarative decision containing both facts and lazy
effect instances:

```ts
const refreshTodos = defineCommand({
  name: "todos.refresh",
  description: "Request fresh todos",
  args: Schema.Struct({}),

  decide: (context, _args) => {
    if (context.state.todos.loading) {
      return Decision.reject("A refresh is already running");
    }

    const requestId = context.commandId;

    return Decision.accept({
      events: [RefreshRequested({ requestId })],
      effects: [FetchTodos({ requestId })],
    });
  },
});
```

Constructing `FetchTodos(...)` must be pure. It creates a value containing
name, serializable arguments, replay policy, scheduling phase, concurrency
policy, and a lazy Effect builder. No API client is touched during `decide`.

### Effect definition API

```ts
const FetchTodos = defineEffect({
  name: "todos.fetch",
  args: Schema.Struct({ requestId: Schema.String }),
  replay: "never",
  phase: "after-commit",
  concurrency: { _tag: "latest", key: () => "todos" },

  run: ({ requestId }) =>
    Effect.gen(function* () {
      const api = yield* TodoApi;
      const cache = yield* TodoCache;
      const rows = yield* api.list();
      const requestHash = yield* cache.put(rows);

      return completeTodosRefresh({
        requestId,
        requestHash,
        count: rows.length,
      });
    }).pipe(
      Effect.catchExpected((error) =>
        Effect.succeed(failTodosRefresh({ requestId, message: error.message })),
      ),
    ),
});
```

The Effect returns an Outcome Command invocation. The runtime dispatches it
with causation metadata linking it to the original command, triggering fact,
and effect execution.

A DOM effect uses the same API but a different phase and replay policy:

```ts
const ScrollToTodo = defineEffect({
  name: "todos.scrollTo",
  args: Schema.Struct({ id: Schema.Number }),
  replay: "opt-in",
  phase: "after-render",
  concurrency: { _tag: "latest", key: () => "todos.viewport" },

  run: ({ id }) =>
    Effect.gen(function* () {
      const viewport = yield* Viewport;
      yield* viewport.scrollTo(`#todo-${id}`);
    }),
});
```

The corresponding decision records intent and chooses the effect:

```ts
return Decision.accept({
  events: [TodoScrollRequested({ id })],
  effects: [ScrollToTodo({ id })],
});
```

Navigating away and back does not rebuild or execute the decision, so it does
not scroll. Theatre mode may explicitly replay effects whose policy allows it.

### Commit ordering

Dispatch should have a strict order:

1. Decode command arguments.
2. Create command envelope (`commandId`, actor, time, causation).
3. Run pure `decide` against the live folded state.
4. If rejected, return with no journal or effect changes.
5. Validate and redact proposed event arguments.
6. Atomically append all facts.
7. Fold all facts.
8. Publish state and journal subscriptions.
9. Schedule accepted effects in their declared phase.
10. Return the committed facts and effect execution IDs.

This answers “when should the effect run?” precisely:

> An effect runs once only when it belongs to an accepted Decision whose facts
> committed successfully at the live head.

### Replay rules

```ts
type ReplayPolicy = "never" | "opt-in";
```

Start with only two policies:

- `never`: network requests, writes, analytics, notifications, clipboard,
  sound, and destructive external operations.
- `opt-in`: semantic viewport positioning or other safe presentational work.

There should be no default `always`. Historical reconstruction is fold-only.
Explicit effect replay is a separate runtime operation with visible devtools
state.

### Failure model

Effect failures need three lanes:

1. **Expected operational failure** becomes an Outcome Command and journaled
   fact, such as `RefreshFailed`.
2. **Interruption** is operational telemetry, not a domain failure, unless the
   feature intentionally records cancellation.
3. **Defect** is reported to the runtime supervisor and devtools. It must not
   be disguised as an ordinary API failure.

Effect execution telemetry should live beside, not inside, the durable
journal:

```ts
interface EffectExecution {
  readonly id: string;
  readonly effect: string;
  readonly triggerSequence: number;
  readonly commandId: string;
  readonly status: "scheduled" | "running" | "succeeded" | "failed" | "interrupted";
  readonly startedAt?: number;
  readonly endedAt?: number;
}
```

The journal records semantic facts. The execution registry explains runtime
behavior.

### Feature composition

Features should remain vertical and export one bundle:

```text
features/todos/
  events.ts
  commands.ts
  effects.ts
  fold.ts
  screen.ts
  services.ts
  feature.ts
  test/
```

```ts
export const todosFeature = defineFeature({
  events: [RefreshRequested, RefreshCompleted, RefreshFailed],
  commands: [refreshTodos, completeTodosRefresh, failTodosRefresh],
  effects: [FetchTodos, ScrollToTodo],
  fold: todosFold,
  screen: todosScreen,
  subscriptions: [],
});
```

The runtime composes features into one journal and one Effect Scope:

```ts
const runtime =
  yield *
  createRuntime({
    features: [routerFeature, settingsFeature, todosFeature],
    services: Layer.mergeAll(TodoApiLive, TodoCacheLive, ViewportLive),
  });
```

Feature composition must reject duplicate command, event, and effect names at
startup.

### Rendering boundary

Effect should run “all the way down” to rendering in the sense that runtime
construction, service acquisition, subscriptions, effect execution, and
cleanup are Effect-managed. The Solid render function itself should remain
synchronous and derived:

```text
Effect runtime → alien-signals store → @cab/store-solid → Solid components
```

The Solid provider should acquire a runtime handle and close its Scope on
cleanup. Components dispatch typed commands and read queries. They should not
run domain Effects directly.

DOM-dependent effects need an `after-render` scheduler service. This is the
specific Remix lesson to adopt; relying on `queueMicrotask` is too implicit.

## How this changes the current POC

The POC currently has an event-keyed effect registry:

```text
committed RefreshRequested → registered fetch handler
committed TodoScrollRequested → registered scroll handler
```

That proved the execution boundary, but it has two limitations:

1. The relationship between a command decision and its effects is indirect.
2. The runtime uses promises and manual subscription bookkeeping instead of
   Effect Scope, Fiber, Layer, Stream, and structured interruption.

The next POC should make effects explicit outputs of `decide` while preserving
the same observable journal:

```text
refreshTodos
  → Decision(events: [RefreshRequested], effects: [FetchTodos])
  → commit RefreshRequested
  → run FetchTodos
  → completeTodosRefresh
  → commit RefreshCompleted
```

The existing behaviour remains the setpoint:

- one attributed, totally ordered journal;
- pure deterministic fold;
- payload cache outside the journal;
- read-only historical state;
- explicit destructive continuation;
- screen context and command introspection;
- effects never execute accidentally during replay or remount;
- optional viewport effect replay;
- Solid remains rendering-only.

## Recommended implementation sequence

### Slice 1 — Effect-native declarations without changing behaviour

Add internal POC primitives:

```ts
defineEvent();
defineCommand();
defineEffect();
Decision.accept();
Decision.reject();
defineFeature();
```

Change `decide` from returning events directly to returning a Decision with
`events` and `effects`. Keep dispatch synchronous through commit and fold.

**Gate:** existing unit and Chromium component tests pass unchanged.

### Slice 2 — Effect runtime and services

Replace `startEffectRunner` promise bookkeeping with an application Scope and
supervised Fibers. Introduce `TodoApi`, `TodoCache`, and `Viewport` services
and provide live/test Layers.

**Gate:** no direct `fetch`, `document`, or cache mutation inside effect
definitions; all dependencies are yielded services.

### Slice 3 — scheduling and concurrency

Implement only observed policies:

```ts
phase: "after-commit" | "after-render"
concurrency: "every" | "latest" | { keyed: (...) => string }
```

Use Fiber interruption and finalizers. Add a renderer acknowledgement so
`after-render` is explicit.

**Gate:** repeated refresh and repeated scroll component tests prove
interruption and no stale outcomes.

### Slice 4 — effect observability

Add an Effects devtools tab showing definitions and live executions, including
trigger sequence, causation, status, duration, interruption, and replay
policy. Keep this telemetry out of the semantic journal.

**Gate:** a user can trace command → facts → effect → outcome facts.

### Slice 5 — feature bundles

Split the POC's central command/fold/runtime files into router, settings,
todos, and ingest feature bundles. Compose them through `defineFeature`.

**Gate:** duplicate registrations fail at startup and feature tests can build a
runtime from only the feature and test Layers they need.

### Slice 6 — scoped streams and resources

Add subscriptions and managed resources only after a second real use case
requires them. Likely candidates are browser history, WebSocket presence, or a
screen-scoped observer.

Do not build Foldkit's full Mount/Subscription/ManagedResource surface in the
first pass.

## Testing strategy

### Pure decision tests

Assert accepted facts/effect descriptions and rejection behaviour without
running Effect programs.

### Fold tests

Refold every journal prefix and prove effects are irrelevant to state
reconstruction.

### Effect tests

Provide test Layers, execute a named effect, and assert its Outcome Command.
Test success, expected failure, interruption, cleanup, and stale-result
handling.

### Runtime tests

Assert atomic ordering:

```text
commit facts → publish state → start effect → dispatch outcome
```

Assert that rejected or failed commits schedule zero effects.

### Browser component tests

Keep Playwright-backed component tests for composed behaviours:

- loading and outcome rendering;
- duplicate refresh/cancellation;
- scroll after render;
- no scroll on remount or unrelated command;
- explicit safe replay;
- screen context and effect introspection;
- theatre scrubbing never performs API calls.

## Risks and decisions

### Effect v4 beta coupling

Foldkit pins an exact Effect beta because beta releases can be incompatible.
Cab already catalog-pins Effect. Keep one workspace version and add a test that
fails on duplicate Effect installations.

### Hot-path cost

The original POC brief intentionally excluded Effect runtime from dispatch.
Adopting this design changes that constraint. Keep `decide`, event append, and
fold synchronous; create lazy Effect values during decision but fork them only
after commit. Benchmark dispatch with and without effects before extracting
`@cab/store`.

### Terminology collision

Do not call side effects “Commands” publicly. Cab's command is an attributed
intent and is central to the agent API. Use `EffectDefinition` and
`EffectInvocation`, even though Foldkit calls the equivalent value a Command.

### Exactly-once claims

The browser runtime can guarantee “scheduled once per successful local
commit,” not globally exactly-once execution. Network mutations still need
idempotency keys and server support. Causation and request IDs must be part of
the envelopes from the beginning.

### Replay safety

Replay policy belongs to the effect definition, but the caller must also opt
in. Both conditions are required. Network effects are never replayable.

## Recommendation

Proceed with Slices 1 and 2 in the POC before changing production packages.
They test the central hypothesis with a small surface:

1. decisions return committed facts plus named lazy Effect invocations;
2. an Effect Scope executes those invocations only after commit;
3. Effect results return as typed outcome commands;
4. Solid observes folded state and acknowledges render completion;
5. theatre replay remains fold-only unless a safe effect and the user both
   opt in.

This moves Cab toward the architecture discussed in `06-store-design.md`
without surrendering its defining property: the attributed journal—not the
Effect runtime, component tree, or devtools snapshot—is the source of truth.
