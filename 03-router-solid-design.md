# Router Ready Model Design: Synchronous State, Mounted Process, Generic Solid Adapter

This document supersedes the previous `03-router-solid-design.md`. It redesigns
the seam across `@cab/store`, `@cab/router`, and `@cab/router-solid` after the
store-bridge implementation exposed two related problems:

- the router's readable state does not exist until an Effect layer resolves;
- the Solid adapter compensates by carrying a provisional seed and naming the
  router's current `href` key.

The replacement follows the useful part of TanStack Router's architecture:
construct the state capability synchronously, represent asynchronous work in
that state, and start process work at the mounted application lifetime.

## PID Setpoint

The observable setpoint is:

```ts
const router = createBrowserRouter();

// The real router model exists now. No Effect service or provider must resolve
// before a hook can synchronously select from it.
render(() => (
  <RouterProvider router={router}>
    <App />
  </RouterProvider>
));
```

The three packages have these responsibilities:

```text
@cab/store
  synchronous snapshot
  dynamic selector dependency tracking
  change-only selector and journal subscriptions

@cab/router
  stable RouterModel: state, journal, reader identity
  mount-scoped Router service: history observation and command I/O

@cab/router-solid
  context and mounted runtime ownership
  generic StoreReader selector -> Solid accessor adaptation
```

The state capability and process lifetime are deliberately separate. The
router model can exist without a mounted process; mounting never replaces or
resets the model.

## Current Error Signal

The current implementation misses the setpoint in concrete ways:

- `Router.layer` creates the store after reading `History.current`, so the real
  `StoreReader` is hidden behind `ManagedRuntime` resolution.
- `SolidRouter` carries both `initialState` and an optional live `reader`, plus
  reader-ready listeners and catch-up logic.
- `SolidRouter.useState` hard-codes `"href"` and reconstructs `{ href }`.
- adding another `RouterState` field requires editing the Solid adapter.
- browser router construction outside a provider produces a seed facade rather
  than a real router model.
- the model and journal are currently coupled to one runtime lifetime, so
  disposal prevents a coherent same-instance remount.
- history reads before listener installation leave a browser startup race.
- the live `journalChanges` tap can start after the first mounted fact.

These are architecture errors, not requests for a broader feature set.

## Relation To The Architecture Review

`ROUTER-PIPELINE-ARCHITECTURE-REVIEW.md` is the accumulated error signal behind
this slice, and the mission in `CONTRIBUTING.md` is the setpoint it measures
against. This redesign closes, from that review:

- the Solid-owned session lifetime and journal reset on provider remount;
- the snapshot-to-live `onEvent` startup gap, scoped to the mounted provider
  lifetime rather than full cursor replay;
- silent `onEvent` callback death and silent stale-callback drops;
- the browser listener-readiness startup race;
- opaque SSR construction over a failed browser layer;
- fault-atomic append, so a reducer defect can never retain facts the
  projection never folded.

It deliberately defers command receipts and correlation identity, canonical
committed hrefs, journal metadata, cursor-based journal reads, session-wide
ordering, back/forward commands, and reversibility. Those remain tracked by the
review's gates and must not silently expand this slice.

## Acceptance Criteria

- `createBrowserRouter(options?)` remains synchronous.
- `createMemoryRouter(options)` remains effectful and still returns
  `{ router, history }`.
- `RouterProvider`, `useRouter`, `useRouterState`, selector and equality options,
  `useRouterNavigate`, `useRouterDispatch`, and `onEvent` retain their names and
  consumer-visible behavior.
- a `SolidRouter` owns one stable router model whose `StoreReader`, state,
  journal, sequence, and identity exist before provider mount.
- provider mount creates process resources around that model; provider unmount
  releases them without deleting model state.
- remounting the same router is supported; concurrent mounts remain rejected.
- `router-solid/src/bridge.ts` contains no `RouterState`, `href`, key list,
  snapshot reconstruction, Effect runtime, or reader-readiness protocol.
- adding a required top-level field to `RouterState` requires no change in
  `@cab/router-solid`.
- selector dependencies are discovered dynamically from the state properties
  read during selector execution.
- an unrelated top-level state change does not rerun a selector that did not
  read that key.
- a reducer defect during dispatch appends no journal facts, publishes no
  stream fact, and leaves state and signals unchanged.
- custom selector equality suppresses downstream Solid notifications exactly as
  it does today.
- the whole-state accessor changes when any state key changes and always returns
  the real folded snapshot.
- history observation installs its listener before sampling the mounted initial
  location, then treats later notifications as lossless wakeups that reread the
  canonical current location under router serialization.
- the mounted `onEvent` observer is registered before catch-up or child dispatch
  can append facts; callback failures do not alter router dispatch.
- navigation functions remain fire-and-forget `void`; history failures remain
  `NavigationFailed` facts.
- separate router instances retain isolated models, journals, runtimes, and
  listeners. Memory and custom histories are isolated; browser routers
  necessarily observe the document's one shared location and therefore converge
  on that location rather than owning isolated histories.

## Design Principles

### Stable Model, Replaceable Process

`RouterModel` is the deep module. It hides the writable store and exposes only a
stable reader. A mounted `Router` service is a replaceable process adapter over
that model and a `History` capability.

```text
RouterModel lifetime
  |---------------------------------------------------------|

provider mount 1       unmounted       provider mount 2
  | process 1 |                           | process 2 |
```

State and journal survive the gap. History listeners, command fibers, runtime
contexts, and UI subscriptions do not.

### Asynchrony Is State, Not State Availability

The browser location and initial router projection are available synchronously.
History observation and navigation I/O remain Effect programs. Future loaders,
guards, and redirects should update pending/error state rather than making the
entire reader unavailable.

### Framework-Neutral Store

Unlike TanStack Router's Solid-specific store factory, `@cab/router` remains
framework-neutral. Dynamic selector tracking belongs to `@cab/store`; Solid
only adapts delivered selected values to signals.

### Effect v4 Alignment

The slice targets the workspace `effect` catalog version (the 4.0 line) and
must stay inside its idioms rather than importing v3 habits:

- services remain `Context.Service` tag classes (`Router`, `History`) with
  plain-interface shapes, matching the existing packages;
- typed, recoverable failures stay on the error channel as `Data.TaggedError`
  values (`HistoryError`); programmer errors — a double process lease, dispatch
  after unmount — are defects or synchronous framework-boundary throws and
  never widen a typed error channel;
- scoped resources are acquired directly inside `Layer.effect`: v4 layers
  exclude `Scope` from their requirements, so `History.observe` and the forked
  wakeup consumer live in the layer build scope and are released by layer
  teardown, with no manual scope plumbing;
- named operations keep the existing `Effect.fn("@cab/...")` instrumentation
  convention;
- `ManagedRuntime` is the only Effect/framework boundary and there is one per
  mounted provider; hooks and the bridge never construct Effects;
- `Effect.runSync` is not a general escape hatch. The one synchronous
  construction boundary is `Store.makeSync`, and even there the dependency
  points from the Effect wrapper to the synchronous core, not the reverse.

## `@cab/store`

### Synchronous Construction

Add a named synchronous constructor while preserving `Store.make`:

```ts
export function makeSync<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): Store<TState, TCommand, TEvent>;

export const Store = {
  defineSlice,
  make,
  makeSync,
} as const;
```

`makeSync` constructs the same store as `make`; it is not a seed-only facade.
The synchronous constructor is the primary implementation, and `Store.make`
delegates to it as `Effect.sync(() => makeSync(definition))`. The dependency
must not point the other way: wrapping `Effect.runSync(make(definition))` would
make the synchronous-allocation promise incidental, and any future asynchronous
step added to `make` would surface as a construction-time defect in every
`makeSync` caller. With the inverted direction, adding an asynchronous
acquisition forces a deliberate signature change. Effect v4 allocates the
store's primitives synchronously (`Ref.makeUnsafe`, `Semaphore.makeUnsafe`,
plain signal creation); where a v4 constructor is exposed only effectfully, a
construction-scoped `runSync` of that single primitive allocation is
acceptable — never a `runSync` over the composed `make`.

`Store.make` remains for Effect-first callers. Future asynchronous hydration
or persistence must be a separate startup operation with its own signature,
not hidden inside store allocation.

### Reader Additions

Extend `StoreReader` additively:

```ts
export interface SelectorSubscriptionOptions<TSelected> {
  readonly equals?: (previous: TSelected, next: TSelected) => boolean;
}

export interface StoreReader<TState extends Record<string, unknown>, TEvent> {
  // Existing state, stateChanges, read, select, subscribe, journal, and
  // journalChanges members remain.

  /** Returns the exact current folded snapshot synchronously and untracked. */
  readonly getSnapshot: () => TState;

  /**
   * Subscribes to change-only selected output. State properties read by the
   * selector are rediscovered on every evaluation.
   */
  readonly subscribeSelector: <TSelected>(
    selector: (state: TState) => TSelected,
    listener: (selected: TSelected) => void,
    options?: SelectorSubscriptionOptions<TSelected>,
  ) => () => void;

  /** Subscribes synchronously to newly committed journal facts. */
  readonly subscribeJournal: (listener: (fact: Sequenced<TEvent>) => void) => () => void;
}
```

### Snapshot Semantics

- `getSnapshot()` returns the authoritative folded object, not a clone, proxy,
  Promise, or Effect.
- its reference is stable until the reducer produces a different state
  reference.
- it never registers an alien-signals dependency.
- reducers retain the existing immutable-state contract.
- the top-level state shape is total and fixed by `definition.initial`.
- Effect v4's `SubscriptionRef.getUnsafe` already reads the committed value
  synchronously, so `getSnapshot` needs no parallel state copy.

### Selector Semantics

- `subscribeSelector` evaluates once to establish its baseline and dependencies
  but does not call the listener initially.
- the default equality is `Object.is`.
- each top-level property read by the selector becomes a dependency.
- dependencies are rediscovered on each evaluation, including when equality
  suppresses the listener.
- nested reads track their top-level owning key; immutable nested references and
  output equality provide deeper deduplication.
- enumerating the tracking view is defined behavior: spread and `Object.keys`
  depend on every top-level key, and an `in` check depends on the queried key.
- a whole-state identity selector tracks all keys and delivers the real
  snapshot, never the internal tracking view.
- selectors are synchronous and pure and must not retain or mutate their state
  argument.
- selector equality and listener execution are untracked so reads there cannot
  widen dependencies.
- batched writes rerun each affected selector once with the final committed
  state.
- listeners retain existing synchronous, enqueue-ack reentrancy semantics.
- unsubscribe is synchronous and idempotent.

The implementation can build a transient proxy or getter-backed state view over
the existing per-key alien signals. It also maintains one private whole-snapshot
signal. That signal is written whenever the folded state reference changes,
even when every top-level value remains `Object.is`-equal. Identity selection
tracks this signal, while ordinary property selectors retain key-fine tracking.
The tracking representation remains private to `@cab/store`.

### Commit And Notification Ordering

One successful dispatch has this order:

```text
decide commands into facts
fold the candidate snapshot from those facts
append retained sequenced facts
publish journalChanges
commit SubscriptionRef state
batch whole-snapshot and per-key signal writes
notify keyed and selector subscribers
notify subscribeJournal listeners
drain listener-enqueued commands
```

The fold moves ahead of the append so the append is fault-atomic: a reducer
defect aborts the dispatch before any fact is retained or published, preserving
the documented replay-equals-state guarantee. `journalChanges` remains a
PubSub-backed stream consumed by asynchronous fibers, so publishing after the
fold changes no observable stream ordering; it only guarantees a fact can never
exist before the projection it produced.

State and selector readers therefore observe the committed projection before a
new synchronous journal listener receives its corresponding fact.
`journalChanges` is not used by Solid. `subscribeJournal` callbacks may throw
at the store interface,
but `@cab/router-solid` must isolate its observational `onEvent` callback so it
cannot fail dispatch.

`stateChanges` and `journalChanges` remain for Effect-land composition. Solid
does not use either stream.

## `@cab/router`

### Stable Router Model

Add a synchronously constructed model:

```ts
export class RouterModel {
  readonly #impl: RouterModelImpl;

  private constructor(impl: RouterModelImpl);

  static make(initialHref: string): RouterModel;

  /** Stable for the full model lifetime. */
  readonly reader: StoreReader<RouterState, RouterEvent>;
}
```

`RouterModel.make(initialHref)` calls
`Store.makeSync(RouterSlice.make(initialHref))`. The writable store is private to
`@cab/router`, either in the private implementation record or a private side
table. Consumers cannot fabricate outcome commands.

The model owns:

- folded router state;
- the retained journal and sequence counter;
- per-key and selector signals;
- the stable `StoreReader` identity.

It owns no browser listener, history adapter, Effect scope, or running fiber.

### Model-Backed Router Layer

Preserve the `Router` Effect service and add prepared-model layers:

```ts
export class Router extends Context.Service<Router, RouterShape>()("@cab/router/Router") {
  /** Existing Effect-first convenience layer remains. */
  static readonly layer: Layer.Layer<Router, HistoryError, History>;

  /** Existing browser convenience layer remains. */
  static readonly layerBrowser: Layer.Layer<Router, HistoryError>;

  /** Builds one mounted process around an existing stable model. */
  static layerFromModel(model: RouterModel): Layer.Layer<Router, HistoryError, History>;

  static layerBrowserFromModel(model: RouterModel): Layer.Layer<Router, HistoryError>;
}
```

`Router.layer` remains compatible by acquiring the scoped history observation
first, creating its internal model from `observation.initialHref`, and running
the same model-backed process over that one observation. The legacy
pre-listener `history.current` read is removed, so the convenience layer
inherits the startup-race fix rather than delegating around it. Framework
adapters use `layerFromModel`; Effect-only consumers are not forced to manage a
model unless they need its lifetime to outlive a layer.

Every model-backed service returns the exact model reader:

```ts
service.reader === model.reader;
```

Building the same model into two concurrent router layers is prohibited. The
model tracks one active process lease and fails layer acquisition descriptively
if another process is active. This collision is a programmer-error defect, not
a typed `HistoryError`, so the existing layer error channels remain accurate.
Sequential layers are supported.

### History Startup Contract

Add one scoped observation operation to the `History` seam while retaining
`current` and `changes` for compatibility:

```ts
export interface HistoryObservation {
  /** Sampled after the change listener has been installed. */
  readonly initialHref: string;

  /** Lossless wakeups captured after the observation linearization point. */
  readonly changes: Stream.Stream<void>;
}

export interface HistoryShape {
  readonly push: (href: string) => Effect.Effect<void, HistoryError>;
  readonly current: Effect.Effect<string, HistoryError>;
  readonly changes: Stream.Stream<string>;

  readonly observe: Effect.Effect<HistoryObservation, HistoryError, Scope.Scope>;
}
```

`WindowHistory.observe` installs `popstate` first, samples the current href
second, and removes the listener when its scope closes. `MemoryHistory` provides
the same contract without relying on replay timing. Notifications are wakeups,
not authoritative captured hrefs: their consumer rereads `history.current`
under the router semaphore. This preserves the current stale-observation safety
when a delayed push and an external change interleave. The wakeup queue is
lossless for the current slice; silent capacity-one sliding coalescing is
removed.

Lossless wakeups are a queue guarantee, not a location-fidelity guarantee.
Because the consumer rereads the canonical current location, rapid external
navigation can still fold several visited locations into one observation:
`A -> B -> A` may journal nothing when both rereads land after the final
transition. The journal records every observation the router made, not every
location the human visited. Per-location observation capture stays deferred
with the collaboration-history work in the architecture review, and this
paragraph is the honest contract until then.

`MemoryHistory`'s inspection handle currently names its external-navigation
simulator `observe(href)`. With `HistoryShape.observe` on the service, two
unrelated meanings of `observe` would sit one import apart, so this slice
renames the handle method to `simulate(href)`. It is test-facing surface with
no production consumers.

### Layer Startup Order

`Router.layerFromModel(model)` acquires work in this order:

1. Acquire `History` and the model's exclusive process lease.
2. Acquire `history.observe`; the listener now exists.
3. Create the router serialization semaphore.
4. Dispatch `NavigationObserved(observation.initialHref)` through the model.
   Equal href is a pure no-op.
5. Start the scoped consumer of later wakeups. Each wakeup rereads
   `history.current` while holding the router semaphore, then dispatches the
   canonical href as `NavigationObserved`.
6. Construct `dispatch` and `navigate` over the same hidden writable store.
7. Publish the `Router` service and its stable model reader.

A dispatch waiting on the layer cannot overtake initial history catch-up.
Location changes occurring during catch-up are already queued by the installed
listener. A queued wakeup can never overwrite newer history with a stale href
because the notification itself carries no state.

Layer release interrupts the observation consumer, closes history observation,
and releases the model lease. It does not dispose the model.

### Existing Router Semantics

The current saga remains otherwise unchanged:

- public dispatch accepts only `RouterCommand`;
- requested intent is journaled before history push;
- successful pushes append `NavigationCommitted` and update state;
- failures append `NavigationFailed` and do not throw to Solid callers;
- external observations append `NavigationObserved` without pushing history;
- one semaphore preserves current navigation/observation ordering.

Broad command receipts, cancellation facts, back/forward commands, and journal
persistence remain separate slices.

One current behavior is therefore explicit rather than hidden: provider
teardown may interrupt a navigation after `NavigationRequested` but before
history produces an outcome. That journal can remain request-only. This slice
must test that interruption appends no false commit or failure. Guaranteeing a
terminal cancellation outcome requires a later cancellation-fact design and is
not implied by this lifecycle refactor.

## `@cab/router-solid`

### Solid Router Construction

`SolidRouter` owns a stable model and enough information to create a fresh
mounted runtime:

```ts
interface SolidRouterImpl {
  readonly model: RouterModel;
  readonly historyLayer: Layer.Layer<History, HistoryError>;
  readonly bridge: ReturnType<typeof RouterBridge.make>;
  readonly onEvent?: (fact: Sequenced<RouterEvent>) => void;

  generation: number;
  activeMount?: SolidRouterMount;
  disposalTail: Promise<void>;
}

interface SolidRouterMount {
  readonly generation: number;
  status: "starting" | "running" | "server" | "failed" | "cancelled";
  readonly ready: Promise<SolidRouterStartResult>;
  runtime?: ManagedRuntime.ManagedRuntime<Router, HistoryError>;
  unsubscribeJournal?: () => void;
  startupError?: unknown;
}

type SolidRouterStartResult =
  | {
      readonly _tag: "Running";
      readonly runtime: ManagedRuntime.ManagedRuntime<Router, HistoryError>;
    }
  | { readonly _tag: "Server" }
  | { readonly _tag: "Failed"; readonly cause: unknown }
  | { readonly _tag: "Cancelled" };
```

Browser construction is synchronous and performs no Effect runtime work:

```ts
export function createBrowserRouter(options?: BrowserRouterOptions): SolidRouter {
  const initialHref = options?.initialHref ?? windowHref();
  const model = RouterModel.make(initialHref);

  return makeSolidRouter(model, WindowHistory.layer, options?.onEvent);
}
```

Memory construction remains effectful only because it returns the inspection
history:

```ts
const history = yield * MemoryHistory.make(options.initialHref);
const model = RouterModel.make(options.initialHref);
const router = makeSolidRouter(model, history.layer, options.onEvent);
```

There is no `initialState`, optional reader, reader listener set, or handoff
between seed state and live state. `model.reader` is the live reader from the
first synchronous render onward.

### Generic Solid Bridge

The bridge knows `StoreReader` and Solid, but no router state fields:

```ts
export const RouterBridge = {
  make<TState extends Record<string, unknown>, TEvent>(reader: StoreReader<TState, TEvent>) {
    return {
      select<TSelected>(
        selector: (state: TState) => TSelected,
        options?: { readonly equals?: (a: TSelected, b: TSelected) => boolean },
      ): Accessor<TSelected> {
        // const [value, setValue] = createSignal(
        //   selector(reader.getSnapshot()),
        //   { equals: false },
        // )
        // const unsubscribe = reader.subscribeSelector(
        //   selector,
        //   (next) => setValue(() => next),
        //   options,
        // )
        // onCleanup(unsubscribe)
      },
    };
  },
} as const;
```

The store selection owns equality, defaulting to `Object.is`. The Solid signal
uses `equals: false` because every delivered value has already crossed the
store's selected-output equality boundary. The setter always receives
`() => next` so function-valued selections are stored as values rather than
invoked as Solid updater functions.

The initial snapshot read and synchronous selector subscription happen in one
JavaScript turn with no Effect boundary between them. The store evaluates the
subscription baseline synchronously. No seed-to-live catch-up protocol is
required because the reader already exists and no other JavaScript callback can
interleave between those operations.

`useRouterState()` delegates to the identity selector. The store defines that
identity selection as a whole-state dependency and returns the real snapshot.
`useRouterState({ select, equals })` delegates the selector unchanged. The
bridge never enumerates keys.

### Provider Mount

Provider mount has this order:

1. Reject a nested provider or concurrent mount of the same router.
2. Increment and capture a mount generation.
3. Install an active `"starting"` mount synchronously. Its `ready` promise gates
   every command from this generation.
4. Render children against the already-live model reader.
5. In the startup task, await the previous generation's `disposalTail`.
6. Recheck that this generation is still active. If it was unmounted while
   waiting, complete without acquiring resources.
7. In a browser, subscribe `onEvent` through
   `model.reader.subscribeJournal`.
8. Create a fresh `ManagedRuntime` from
   `Router.layerFromModel(model).pipe(Layer.provide(historyLayer))`.
9. Start and await runtime context construction, then mark the mount
   `"running"`.
10. Capture startup failure as a non-rejecting `Failed` start result and retain
    its cause for descriptive later callback errors.

Because the journal listener is synchronous and installed before runtime
startup, it observes initial history catch-up and immediate child-effect
navigation without a live-stream startup gap. A child-effect command invoked
while the mount is `"starting"` remains fire-and-forget to the component but
waits on `ready`; it cannot overtake prior disposal, journal subscription, or
initial history catch-up.

`ready` never rejects. A command queued during startup branches on its result:

- `Running` revalidates the generation and forks the command;
- `Cancelled` performs no work because cleanup already invalidated it;
- `Server` reports the existing descriptive browser-mount error;
- `Failed` reports the startup diagnostic and performs no dispatch.

No branch creates an unhandled Promise rejection. A callback invoked after the
mount enters `"failed"` throws synchronously with `startupError`; an
already-returned queued callback can only report through the package diagnostic
path.

Provider cleanup:

1. Atomically detaches the active generation so callbacks fail immediately.
2. Prevents a not-yet-started generation from acquiring resources.
3. Unsubscribes this generation's `onEvent` journal listener when present.
4. Calls and awaits this generation's `runtime.dispose()` when present.
5. Stores the complete startup/disposal chain as `disposalTail`.
6. Releases history observation and the model process lease through layer scope.
7. Leaves model state, journal, sequence, bridge, and reader untouched.

Remount installs its `"starting"` generation synchronously but does not
subscribe `onEvent`, acquire history, or create a runtime until `disposalTail`
completes. It reuses the same model. Initial history catch-up reconciles
location changes made while unmounted. Individual browser actions while
unmounted are intentionally not recoverable because no listener exists during
that explicit lifetime gap.

Hook-returned dispatch functions capture their mount generation and its `ready`
promise. A function captured from generation 1 throws after unmount and must not
dispatch into generation 2.

### `onEvent` Failure Isolation

The `subscribeJournal` listener wraps each callback attempt:

```ts
try {
  onEvent(fact);
} catch (cause) {
  // Report through the package's diagnostic path; never rethrow into dispatch.
}
```

Delivery is ascending and live-only for each mounted provider lifetime. Facts
produced while no provider is mounted are retained in the model journal but are
not replayed to `onEvent`, matching its documented mounted-lifetime semantics.

### Server Behavior

Add an optional browser construction seed without changing existing calls:

```ts
export interface BrowserRouterOptions extends RouterOptions {
  readonly initialHref?: string;
}
```

In a browser, the default remains `window.location`. Outside a browser, the
default remains `"/"`. A provider mounting outside a browser takes an explicit
server branch before scheduling process startup: it installs context and Solid
selector ownership only, resolves the mount's `ready` value as `Server`, and
does not subscribe `onEvent`, construct a `ManagedRuntime`, or acquire
`WindowHistory`. Passing `initialHref` lets SSR render a request URL without
touching `window`. Client mount then reconciles the actual browser href through
the listener-first history contract.

Navigation callbacks outside an active browser mount throw descriptively.

## Compatibility Table

| Package             | Existing interface                                                       | Decision                                              |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `@cab/store`        | `Store.make`                                                             | Preserve                                              |
| `@cab/store`        | `StoreReader.state`, `stateChanges`, `read`, `select`, keyed `subscribe` | Preserve                                              |
| `@cab/store`        | `Store.makeSync`, `getSnapshot`, `subscribeSelector`, `subscribeJournal` | Add                                                   |
| `@cab/router`       | `Router`, `RouterShape`, `Router.layer`, `Router.layerBrowser`           | Preserve                                              |
| `@cab/router`       | `RouterModel`, `layerFromModel`, `layerBrowserFromModel`                 | Add                                                   |
| `@cab/router`       | implementations of exported `HistoryShape`                               | Required migration: implement scoped `observe`        |
| `@cab/router`       | `MemoryHistory` handle `observe(href)`                                   | Required migration: renamed to `simulate(href)`       |
| `@cab/router-solid` | `createBrowserRouter(options?)`                                          | Preserve; options gain optional `initialHref`         |
| `@cab/router-solid` | `createMemoryRouter(options)` and `{ router, history }`                  | Preserve                                              |
| `@cab/router-solid` | `RouterProvider`, `useRouter`                                            | Preserve                                              |
| `@cab/router-solid` | exported `SolidRouter` class value                                       | Preserve instances; make construction module-private  |
| `@cab/router-solid` | `useRouterState()`                                                       | Preserve; now reads the real model immediately        |
| `@cab/router-solid` | `useRouterState({ select, equals })`                                     | Preserve; selection moves into store                  |
| `@cab/router-solid` | `useRouterNavigate`, `useRouterDispatch`                                 | Preserve fire-and-forget `void`                       |
| `@cab/router-solid` | `onEvent(Sequenced<RouterEvent>)`                                        | Preserve                                              |
| `@cab/router-solid` | remounting a disposed router throws                                      | Intentionally change: sequential remount is supported |

No raw writable store is exposed. `useRouter()` remains the advanced Solid
escape hatch, but `SolidRouter` does not publicly expose the writable model
implementation.

Removing the currently callable `SolidRouter.make(layer, initialState,
onEvent?)` is an intentional source migration. It was not part of the frozen
consumer surface, and preserving it would reintroduce a provisional state
model. Consumers construct instances through `createBrowserRouter` or
`createMemoryRouter`; package internals use module-private `makeSolidRouter`.

## Public API Surface

The complete post-slice public surface, written for line-level review. Items
are marked `existing` (unchanged), `added`, or `changed`. Anything not listed
here is package-private.

### `@cab/store`

```ts
/** existing */
export interface Sequenced<TEvent> {
  readonly sequence: number;
  readonly event: TEvent;
}

/** existing */
export interface SliceDefinition<TState extends Record<string, unknown>, TCommand, TEvent> {
  readonly name: string;
  readonly initial: TState;
  readonly decide: (state: TState, command: TCommand) => ReadonlyArray<TEvent>;
  readonly reduce: (state: TState, event: TEvent) => TState;
}

/** existing */
export function defineSlice<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): SliceDefinition<TState, TCommand, TEvent>;

/** added */
export interface SelectorSubscriptionOptions<TSelected> {
  readonly equals?: (previous: TSelected, next: TSelected) => boolean;
}

export interface StoreReader<TState extends Record<string, unknown>, TEvent> {
  /** existing */
  readonly state: Effect.Effect<TState>;
  /** existing */
  readonly stateChanges: Stream.Stream<TState>;
  /** existing */
  readonly read: <K extends keyof TState>(key: K) => TState[K];
  /** existing */
  readonly select: <T>(selector: () => T) => () => T;
  /** existing */
  readonly subscribe: <K extends keyof TState>(
    key: K,
    listener: (value: TState[K]) => void,
  ) => () => void;
  /** existing */
  readonly journal: Effect.Effect<ReadonlyArray<Sequenced<TEvent>>>;
  /** existing */
  readonly journalChanges: Stream.Stream<Sequenced<TEvent>>;
  /** added */
  readonly getSnapshot: () => TState;
  /** added */
  readonly subscribeSelector: <TSelected>(
    selector: (state: TState) => TSelected,
    listener: (selected: TSelected) => void,
    options?: SelectorSubscriptionOptions<TSelected>,
  ) => () => void;
  /** added */
  readonly subscribeJournal: (listener: (fact: Sequenced<TEvent>) => void) => () => void;
}

/** existing */
export interface Store<
  TState extends Record<string, unknown>,
  TCommand,
  TEvent,
> extends StoreReader<TState, TEvent> {
  readonly dispatch: (command: TCommand) => Effect.Effect<void>;
  readonly reader: StoreReader<TState, TEvent>;
}

/** added: the primary constructor */
export function makeSync<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): Store<TState, TCommand, TEvent>;

/** changed: signature preserved; now `Effect.sync(() => makeSync(definition))` */
export function make<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): Effect.Effect<Store<TState, TCommand, TEvent>>;

/** changed: gains `makeSync` */
export const Store: {
  readonly defineSlice: typeof defineSlice;
  readonly make: typeof make;
  readonly makeSync: typeof makeSync;
};
```

### `@cab/router`

```ts
/** existing */
export type HistoryErrorReason = "window-unavailable" | "push-failed";

/** existing */
export class HistoryError extends Data.TaggedError("HistoryError")<{
  readonly reason: HistoryErrorReason;
  readonly cause?: unknown;
}> {}

/** added */
export interface HistoryObservation {
  /** Sampled after the change listener has been installed. */
  readonly initialHref: string;
  /** Lossless wakeups captured after the observation linearization point. */
  readonly changes: Stream.Stream<void>;
}

export interface HistoryShape {
  /** existing */
  readonly push: (href: string) => Effect.Effect<void, HistoryError>;
  /** existing */
  readonly current: Effect.Effect<string, HistoryError>;
  /** existing */
  readonly changes: Stream.Stream<string>;
  /** added: required migration for every implementation */
  readonly observe: Effect.Effect<HistoryObservation, HistoryError, Scope.Scope>;
}

/** existing */
export class History extends Context.Service<History, HistoryShape>()("@cab/router/History") {}

/** changed: layer now implements listener-first `observe` */
export const WindowHistory: {
  readonly layer: Layer.Layer<History, HistoryError>;
};

/** changed: handle method `observe(href)` renamed to `simulate(href)` */
export interface MemoryHistory {
  readonly layer: Layer.Layer<History>;
  readonly pushes: Effect.Effect<ReadonlyArray<string>>;
  readonly current: Effect.Effect<string>;
  readonly simulate: (href: string) => Effect.Effect<void>;
}

/** existing */
export const MemoryHistory: {
  readonly make: (initialHref: string) => Effect.Effect<MemoryHistory>;
};

/** existing */
export type RouterState = {
  readonly href: string;
};

/** existing */
export type RouterCommand = Data.TaggedEnum<{
  NavigationRequested: { readonly href: string };
}>;
export const RouterCommand: Data.TaggedEnum.Constructors<RouterCommand>;

/** existing */
export type RouterEvent = Data.TaggedEnum<{
  NavigationRequested: { readonly href: string };
  NavigationCommitted: { readonly href: string };
  NavigationObserved: { readonly href: string };
  NavigationFailed: {
    readonly href: string;
    readonly reason: HistoryErrorReason;
    readonly cause?: unknown;
  };
}>;
export const RouterEvent: Data.TaggedEnum.Constructors<RouterEvent>;

/** existing */
export function initial(href: string): RouterState;

/** existing */
export const RouterSlice: {
  readonly make: (href: string) => SliceDefinition<RouterState, RouterSliceCommand, RouterEvent>;
};

/** added */
export class RouterModel {
  static make(initialHref: string): RouterModel;
  /** Stable for the full model lifetime. */
  readonly reader: StoreReader<RouterState, RouterEvent>;
}

/** existing */
export interface RouterShape {
  readonly dispatch: (command: RouterCommand) => Effect.Effect<void>;
  readonly navigate: (href: string) => Effect.Effect<void>;
  readonly reader: StoreReader<RouterState, RouterEvent>;
}

export class Router extends Context.Service<Router, RouterShape>()("@cab/router/Router") {
  /** existing; internals change to build the model from `observe().initialHref` */
  static readonly layer: Layer.Layer<Router, HistoryError, History>;
  /** existing */
  static readonly layerBrowser: Layer.Layer<Router, HistoryError>;
  /** added */
  static layerFromModel(model: RouterModel): Layer.Layer<Router, HistoryError, History>;
  /** added */
  static layerBrowserFromModel(model: RouterModel): Layer.Layer<Router, HistoryError>;
}
```

### `@cab/router-solid`

```ts
/**
 * existing: opaque instance handle exported for typing and `instanceof`.
 * changed: no public constructor or static methods; construction is
 * module-private `makeSolidRouter`, consumed through the functions below.
 */
export class SolidRouter {}

/** existing */
export interface RouterOptions {
  readonly onEvent?: (event: Sequenced<RouterEvent>) => void;
}

/** added */
export interface BrowserRouterOptions extends RouterOptions {
  readonly initialHref?: string;
}

/** existing */
export interface MemoryRouter {
  readonly router: SolidRouter;
  readonly history: MemoryHistory;
}

/** changed: accepts `BrowserRouterOptions`; allocates the model synchronously */
export function createBrowserRouter(options?: BrowserRouterOptions): SolidRouter;

/** existing */
export const createMemoryRouter: (
  options: RouterOptions & { readonly initialHref: string },
) => Effect.Effect<MemoryRouter>;

/** existing */
export function RouterProvider(props: {
  readonly router: SolidRouter;
  readonly children?: JSX.Element;
}): JSX.Element;

/** existing */
export function useRouter(): SolidRouter;

/** existing */
export interface UseRouterStateOptions<TSelected> {
  readonly select: (state: RouterState) => TSelected;
  readonly equals?: (prev: TSelected, next: TSelected) => boolean;
}

/** existing; selection now executes inside the store with dynamic tracking */
export function useRouterState(): Accessor<RouterState>;
export function useRouterState<TSelected>(
  options: UseRouterStateOptions<TSelected>,
): Accessor<TSelected>;

/** existing */
export function useRouterNavigate(): (href: string) => void;

/** existing */
export function useRouterDispatch(): (command: RouterCommand) => void;
```

## Consumer Example: Three Routes In Solid

How an application consumes the three packages together. Route matching is
deliberately manual: this slice ships href state, not a matcher, so the
application selects the pathname and branches. The example still exercises the
whole setpoint — synchronous model construction, fine-grained selectors,
fire-and-forget navigation, and journal observation.

```tsx
import { Match, Switch } from "solid-js";
import { render } from "solid-js/web";

import {
  createBrowserRouter,
  RouterProvider,
  useRouterNavigate,
  useRouterState,
} from "@cab/router-solid";

// The model — state, journal, reader — exists as soon as this line runs.
// No provider has mounted and no Effect runtime has started.
const router = createBrowserRouter({
  onEvent: (fact) => {
    console.debug(`[router] #${fact.sequence} ${fact.event._tag}`, fact.event);
  },
});

function pathname(href: string): string {
  return new URL(href, "http://localhost").pathname;
}

function Link(props: { readonly href: string; readonly label: string }) {
  const navigate = useRouterNavigate();

  // The selector runs inside the store. It reads only `href`, so a future
  // state key (pending loaders, errors) will never rerun it.
  const active = useRouterState({
    select: (state) => pathname(state.href) === props.href,
  });

  return (
    <a
      href={props.href}
      aria-current={active() ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        // Fire-and-forget by design: a failed push becomes a
        // NavigationFailed journal fact, not an exception here.
        navigate(props.href);
      }}
    >
      {props.label}
    </a>
  );
}

function Home() {
  return <h1>Home</h1>;
}

function About() {
  return <h1>About</h1>;
}

function Contact() {
  const navigate = useRouterNavigate();

  return (
    <section>
      <h1>Contact</h1>
      <button onClick={() => navigate("/")}>Done</button>
    </section>
  );
}

function Screen() {
  const path = useRouterState({
    select: (state) => pathname(state.href),
  });

  return (
    <Switch fallback={<h1>Not Found</h1>}>
      <Match when={path() === "/"}>
        <Home />
      </Match>
      <Match when={path() === "/about"}>
        <About />
      </Match>
      <Match when={path() === "/contact"}>
        <Contact />
      </Match>
    </Switch>
  );
}

function App() {
  return (
    <>
      <nav>
        <Link href="/" label="Home" />
        <Link href="/about" label="About" />
        <Link href="/contact" label="Contact" />
      </nav>
      <main>
        <Screen />
      </main>
    </>
  );
}

render(
  () => (
    <RouterProvider router={router}>
      <App />
    </RouterProvider>
  ),
  document.getElementById("root")!,
);
```

Behavior the example inherits without extra code:

- the first render reads the real synchronous model; there is no readiness
  window or provisional seed;
- browser back/forward appends `NavigationObserved` facts and updates every
  selector through the same canonical reread path;
- clicking a link for the current location is a pure no-op: `decide` dedupes
  the equal href and appends nothing;
- every requested, committed, observed, and failed navigation reaches
  `onEvent` in journal order while the provider is mounted, so an agent or
  devtool observing the session sees intent and outcome as facts, not
  screenshots.

## Test Design

### `@cab/store`

Add tests that prove:

- `makeSync` returns the same complete store behavior as `make`;
- `getSnapshot` is synchronous, exact, untracked, and reference-stable;
- a fresh folded object with equal key values updates whole-state identity
  selection without rerunning unrelated property selectors;
- snapshot commit precedes keyed, selector, and journal listeners;
- a reducer defect in a single-event and a multi-event dispatch appends no
  facts, publishes no stream fact, and leaves state and signals unchanged;
- a selector tracks one key and ignores an unrelated key change;
- a multi-key selector reruns once for one batched dispatch;
- conditional selectors replace their dynamic dependencies;
- dependency replacement still occurs when equality suppresses notification;
- identity selection tracks the whole state and returns the real snapshot;
- nested selection tracks the owning top-level key;
- a spread or `Object.keys` selector reruns for any top-level key change;
- a function-valued selection is delivered as a value;
- custom equality suppresses equal object output;
- default equality uses `Object.is`;
- listener/equality reads do not widen selector dependencies;
- unsubscribe is idempotent and prevents later notifications;
- selector listeners preserve current enqueue-ack behavior;
- journal subscribers receive committed state and ascending facts;
- a throwing journal subscriber follows documented store behavior.

Use the existing two-key settings slice to measure selector invocation counts;
do not infer fine-graining only from rendered output.

### `@cab/router`

Add and port tests that prove:

- `RouterModel.make("/seed")` exposes `{ href: "/seed" }` synchronously;
- a model-backed service returns the exact same reader;
- navigation updates the pre-existing model and journal;
- sequential layer lifetimes preserve reader, state, journal, and sequence;
- concurrent process acquisition for one model fails descriptively;
- listener installation precedes mounted initial history sampling;
- browser or memory drift before mount produces one catch-up observation;
- a history change during startup is not lost;
- queued wakeups reread canonical `history.current` and cannot apply stale hrefs
  after a delayed push;
- current-read failure during an observation leaves state unchanged;
- initial catch-up completes before the first waiting command;
- layer release removes the history listener and process lease;
- disposing during a deferred history push can leave a request-only journal and
  never appends a false terminal outcome;
- current request/commit/failure/dedup and type-narrowing tests remain green;
- the legacy `Router.layer` convenience retains Effect-first behavior.

Use `Deferred` handshakes rather than timers for startup race tests.

### `@cab/router-solid`

Port existing behavioral tests and add assertions that prove:

- first render reads the model reader, not a provisional seed;
- the bridge works against a generic two-key store fixture;
- a selector reading one key is not invoked for another key;
- adding a second router-state field requires no bridge change;
- custom equality preserves current selected-output behavior;
- immediate child-effect navigation reaches `onEvent` in sequence;
- initial history catch-up reaches both state hooks and `onEvent`;
- unmount stops selector, journal, history, and runtime work;
- unmount during a deferred navigation produces no post-unmount outcome;
- the same router remounts with preserved state and sequence;
- drift while unmounted is reconciled once on remount;
- immediate unmount/remount with child-effect navigation waits for prior
  disposal and produces no generation-1 event delivery;
- concurrent mounts and nested providers still throw;
- stale generation callbacks throw after unmount and after remount;
- two router instances remain independent;
- two memory routers have isolated histories, while browser-backed instances
  consistently observe their shared document history;
- startup failure leaves the model readable and permits a later remount;
- a command queued before startup failure performs no dispatch, produces no
  unhandled rejection, and reports the startup diagnostic;
- `onEvent` exceptions do not terminate later delivery;
- an SSR provider reads `initialHref` without constructing a runtime,
  subscribing `onEvent`, or acquiring browser history.

Add public-entrypoint type tests for selector inference, function-valued
selection, custom equality, constructor signatures, the required
`HistoryShape.observe` migration, `Sequenced<RouterEvent>`, and command
narrowing.

## Implementation Sequence

Land this as one coordinated slice; intermediate commits may not leave the
workspace adapter on a half-migrated reader interface.

1. Add `Store.makeSync`, `getSnapshot`, `subscribeSelector`, and
   `subscribeJournal` with focused store tests.
2. Reorder dispatch to fold before append, publish `journalChanges` after the
   fold, and notify the new synchronous journal subscribers after projection
   commit.
3. Add `History.observe` to browser and memory adapters with listener-first,
   scoped tests.
4. Add `RouterModel` and model-backed router layers; preserve legacy layers by
   delegating to the same implementation.
5. Port router tests to prove stable model identity, startup catch-up, process
   lease behavior, and sequential remount.
6. Rewrite `RouterBridge` over `getSnapshot` and `subscribeSelector`; remove all
   router key knowledge and reader-readiness logic.
7. Rewrite `SolidRouter` around a stable model and per-mount runtime; register
   `onEvent` before runtime startup.
8. Replace the disposed-remount rejection test with state/journal-preserving
   remount coverage and generation-safe stale callback tests.
9. Add server `initialHref` behavior and update all three package READMEs.
10. Remove obsolete seed, reader listener, `journalChanges` tap, and key bridge
    code only after focused sensors pass.
11. Run close-out sensors and a browser navigation/back-forward smoke test.

## PID Control Loop

### Focused Sensors

Run after each package-local corrective action:

```bash
pnpm --filter=@cab/store run tsc
pnpm --filter=@cab/store run lint
pnpm --filter=@cab/store run test:unit

pnpm --filter=@cab/router run tsc
pnpm --filter=@cab/router run lint
pnpm --filter=@cab/router run test:unit

pnpm --filter=@cab/router-solid run tsc
pnpm --filter=@cab/router-solid run lint
pnpm --filter=@cab/router-solid run test:unit
```

### Close-Out Sensors

```bash
pnpm fmt
pnpm fmt:check
pnpm tsc
pnpm lint
pnpm turbo run test:unit
```

Manual browser sensor:

- create the browser router before rendering;
- verify the first href is synchronous;
- navigate and dispatch through hooks;
- drive browser back/forward during and between mounts;
- verify ordered requested, committed, observed, and failed facts;
- unmount and verify no browser or event work continues;
- remount and verify one catch-up with preserved journal sequence.

### Error Signals And Controller Actions

| Error signal                              | Smallest controller action                                            |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Adapter names a router key                | Move selector dependency discovery into `StoreReader`                 |
| First render waits for runtime            | Move store allocation into `RouterModel.make`                         |
| Reader identity changes at mount          | Reuse `model.reader` in every layer                                   |
| Selector reruns for unrelated key         | Fix tracked state-view dependencies; do not add key lists to Solid    |
| First popstate or event is lost           | Fix acquisition ordering at `History.observe` or journal subscription |
| Journal retains a fact state never folded | Fold the candidate snapshot before appending facts                    |
| Remount resets state or sequence          | Recreate process runtime, not model                                   |
| Remount overlaps prior disposal           | Keep generation `"starting"` and gate all startup on `disposalTail`   |
| Old callback dispatches after remount     | Capture and validate mount generation                                 |
| Cleanup leak                              | Pair every subscription and runtime with its owning cleanup sensor    |
| Broad API break                           | Restore compatibility and add an additive capability instead          |

Integral feedback comes from the existing command/fact/projection tests,
reentrancy contracts, current Solid public surface, and architecture review.
Derivative feedback must specifically guard against startup gaps, duplicate
processes, selector over-invalidation, stale callbacks, and unmount/remount
overlap before each edit.

## Stability Rules

- Keep the command, fact, projection, and read/write capability split.
- Keep state shape knowledge inside `@cab/router`; never move it into a
  framework adapter.
- Do not replace selector tracking with a whole-snapshot stream.
- Do not make `createBrowserRouter` effectful or Promise-returning.
- Do not use `ManagedRuntime.runSync` to make arbitrary layer acquisition a
  permanent synchronous requirement.
- Do not create a second provisional store or replace the model reader.
- Do not expose writable router outcome commands.
- Do not silently queue navigation while no provider process is mounted.
- Do not permit two active processes over one model.
- Do not claim that teardown-interrupted requests have terminal outcomes until
  cancellation facts are designed and tested.
- Do not preserve the one-shot disposed-router rule; process remount is part of
  the new setpoint.
- Do not broaden this slice into persistence, multiplayer journal ordering,
  route matching, loaders, links, back/forward commands, or generic
  `@cab/store-solid` extraction.
- Preserve user changes outside the three packages and this root design file.

## Rejected Alternatives

### Start The Existing Runtime Earlier

Calling `runtime.runFork(Router)` inside `createBrowserRouter` shortens the
readiness window but does not guarantee a synchronous reader. It also starts
history resources before any mounted owner exists. The model/process split
removes the window rather than racing it.

### Resolve The Browser Layer With `runSync`

This makes every future layer acquisition synchronously constrained, turns
typed startup failure into construction throws, and behaves poorly during SSR.
Only the in-memory model is promised synchronous construction.

### Keep A Generic Key List In `router-solid`

Generating key accessors from `Object.keys(initialState)` removes the literal
`href` but still makes the adapter own selector dependency policy and optional
key semantics. The store already owns per-key signals and is the deeper module.

### Bridge `stateChanges`

A snapshot stream makes every selector observe every state-reference change and
reintroduces broad invalidation. It also does not solve synchronous source
availability.

### Inject Solid Signals Into Router Core

TanStack Router uses this effectively, but Cab's framework-neutral store is an
intentional composition seam. Selector subscription gives Solid the required
leverage without coupling `@cab/router` to Solid.

## Completion Definition

The setpoint is reached only when a new top-level router state field can be
added and selected from Solid without touching `libs/router-solid`, the real
state is synchronously readable before provider mount, all focused and
close-out sensors pass, and mount/unmount/remount cycles preserve model state
while leaking no process resources.
