# @cab/store

`@cab/store` is an event-sourced, fine-grained reactive store for cab
applications.

Writes go through a journal: commands are decided into events, events are
appended with gapless sequences, and state is the pure fold of those events.
Reads are fine-grained: every top-level state key is backed by its own signal,
so subscribers of one key never hear about changes to another. The package is
framework-agnostic and built on `effect` and `alien-signals`.

## Why This Exists

Most reactive stores work hard to discover what changed — proxies, snapshot
diffing, or re-running every subscriber's selector on every update. An
event-sourced store does not need to discover change: the event **is** the
change description. `@cab/store` exploits that by folding events into one
signal per state key and letting signal equality cutoff drop unchanged keys.

The division of responsibility is as follows Redux:

```text
you own:        commands, events, decide, reduce
the store owns: journaling, sequencing, serialization, reactivity
```

## Current Scope

One slice per store instance, flat top-level keys, in-memory journal.

It intentionally does not yet provide:

- deep-path subscriptions (`read("a.b.c")`) — subscribe to a top-level key and
  derive leaves with `select`
- entity-collection primitives (keyed rows, per-row signals)
- persistence, replay-from-storage, snapshotting, or journal compaction
- cross-slice composition
- framework adapters — this package never touches Solid, React, or atoms

## Installation

Inside this workspace, add the store to a package:

```bash
pnpm --filter=@cab/your-package add @cab/store@workspace:*
```

`@cab/store` depends on `effect` and `alien-signals`, both managed through the
workspace catalog.

## Quick Start

Define a slice (your domain), make a store (the machinery), dispatch commands,
and subscribe to exactly the keys you care about:

```ts
import { Data, Effect } from "effect";
import { Store } from "@cab/store";

type SettingsCommand = Data.TaggedEnum<{
  FooChanged: { readonly foo: string };
  BazChanged: { readonly baz: string };
}>;
const SettingsCommand = Data.taggedEnum<SettingsCommand>();

type SettingsEvent = Data.TaggedEnum<{
  FooChanged: { readonly foo: string };
  BazChanged: { readonly baz: string };
}>;
const SettingsEvent = Data.taggedEnum<SettingsEvent>();

const settings = Store.defineSlice({
  name: "settings",
  initial: { foo: "bar", baz: "ball" },
  decide: (state, command: SettingsCommand): ReadonlyArray<SettingsEvent> =>
    SettingsCommand.$match(command, {
      FooChanged: ({ foo }) => (state.foo === foo ? [] : [SettingsEvent.FooChanged({ foo })]),
      BazChanged: ({ baz }) => (state.baz === baz ? [] : [SettingsEvent.BazChanged({ baz })]),
    }),
  reduce: (state, event: SettingsEvent) =>
    SettingsEvent.$match(event, {
      FooChanged: ({ foo }) => ({ ...state, foo }),
      BazChanged: ({ baz }) => ({ ...state, baz }),
    }),
});

const store = Store.makeSync(settings);

const program = Effect.gen(function* () {
  const unsubscribe = store.subscribe("baz", (baz) => {
    console.log("baz is now", baz);
  });

  // The baz subscriber does not fire: only foo changed.
  yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));

  // The baz subscriber fires exactly once with "bat".
  yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));

  // The journal holds every accepted fact, and folding it always
  // reproduces the current state.
  console.log(yield* store.journal);
  // [
  //   { sequence: 0, event: { _tag: "FooChanged", foo: "next" } },
  //   { sequence: 1, event: { _tag: "BazChanged", baz: "bat" } },
  // ]

  unsubscribe();
});
```

## Core Concepts

### Slice Definition

A `SliceDefinition` is the domain contract: two pure functions around an
initial state.

- `decide(state, command)` turns caller intent into zero or more events. It is
  the only place that can say no — validation, dedup, and business rules live
  here. Return `[]` to no-op.
- `reduce(state, event)` is the total fold from a fact to the next state. It
  never rejects; events are already accepted history.

`defineSlice` is an identity helper that pins type inference across state,
command, and event.

```ts
const slice = Store.defineSlice({ name, initial, decide, reduce });
```

Reducers MUST preserve reference identity for keys they do not touch
(spread-update style does this naturally). That identity is what lets the
store skip notifications for unchanged keys, at any depth.

### Store

`Store.makeSync(definition)` synchronously builds one complete store instance
and is the primary constructor. `Store.make(definition)` builds the same store
inside an `Effect` for Effect-first callers. The store serializes dispatches,
assigns gapless sequences, retains the journal, and keeps one signal per
top-level state key.

### Reader

`store.reader` is the store minus `dispatch` — the full read, subscription,
and journal surface. Hand it out when consumers should observe state but not
write it, for example from a service that guards writes behind its own I/O
saga:

```ts
export class Settings extends Context.Service<Settings, SettingsShape>()("app/Settings") {
  // expose: dispatch wrapped in domain logic, plus store.reader for reads
}
```

## Public API

### `Store.defineSlice(definition)` / `defineSlice`

Pins inference for a `SliceDefinition<TState, TCommand, TEvent>`. `TState`
must be a flat record; each top-level key becomes an independently observable
signal.

### `Store.makeSync(definition)` / `makeSync`

`Store<TState, TCommand, TEvent>`. The synchronous primary constructor returns
a complete store whose state, subscriptions, and journal are ready immediately.

### `Store.make(definition)` / `make`

`Effect.Effect<Store<TState, TCommand, TEvent>>`. Construction is pure and
synchronous-safe; it delegates to `makeSync` for Effect-first callers. No scope
is required, and unused stores are simply garbage collected.

### `store.dispatch(command)`

`(command: TCommand) => Effect.Effect<void>`

Runs `decide`, folds the complete candidate state, appends the resulting facts,
commits the state, and notifies affected subscribers — all synchronously.
`Effect.runSync` on a dispatch is supported: when it returns, subscribers have
already fired. If a reducer defects while folding any event, the dispatch is
fault-atomic: no facts are retained or published, and state and signals remain
unchanged.

Dispatching from inside a subscriber listener is supported. The command is
enqueued and applied in FIFO order before the boundary dispatch returns; from
the listener's perspective it is fire-and-forget (reads immediately after it
still see pre-command state). Cascades terminate naturally when `decide`
returns `[]`; a cascade exceeding 1000 commands fails with a descriptive
defect instead of freezing.

### `store.read(key)`

`<K extends keyof TState>(key: K) => TState[K]`

Synchronous read of one key. Inside a reactive computation (`select`, or a
signal effect), the read is tracked and registers a dependency; outside, it is
a plain read.

### `store.getSnapshot()`

`() => TState`

Returns the exact current folded snapshot synchronously and without registering
a reactive dependency. The reference remains stable until a reducer returns a
different state object.

### `store.select(selector)`

`<T>(selector: () => T) => () => T`

Builds a memoized accessor over `read` calls. The selector re-runs when any
key it reads changes, but downstream consumers are only notified when the
selector's **output** changes — so selecting a deeply nested leaf notifies
only on real leaf changes, even when siblings or ancestors move.

### `store.subscribe(key, listener)`

`<K extends keyof TState>(key: K, listener: (value: TState[K]) => void) => () => void`

Change-only subscription to one key: the listener fires with the new value
after each dispatch that actually changed it, and never for other keys.
Returns an unsubscribe function; the caller owns the lifetime. Listeners run
untracked, so reads inside a listener never widen the subscription.

### `store.subscribeSelector(selector, listener, options?)`

```ts
<TSelected>(
  selector: (state: TState) => TSelected,
  listener: (selected: TSelected) => void,
  options?: { readonly equals?: (previous: TSelected, next: TSelected) => boolean },
) => () => void
```

Evaluates once to establish a baseline without calling the listener, then
subscribes to change-only selected output. Top-level keys read by the selector
become dependencies and are rediscovered on every evaluation, so conditional
selectors can change which keys they observe. Equality defaults to `Object.is`;
pass `equals` to customize selected-output deduplication. Nested reads track
their owning top-level key, while spread, `Object.keys`, and whole-state
selection track all top-level keys. Returns a synchronous, idempotent
unsubscribe function.

### `store.state` / `store.stateChanges`

`Effect.Effect<TState>` and `Stream.Stream<TState>` — the Effect-land views.
`state` reads the current folded snapshot without registering a dependency.
`stateChanges` emits the current snapshot on subscription and each folded
snapshot whose state reference changed. Accepted journal-only facts whose reducer
returns the previous state reference do not emit.

### `store.journal` / `store.journalChanges`

`Effect.Effect<ReadonlyArray<Sequenced<TEvent>>>` and
`Stream.Stream<Sequenced<TEvent>>` — the retained journal snapshot and the
live stream of newly appended facts. `journalChanges` is live-only:
subscribers receive facts appended after their subscription starts.

### `store.subscribeJournal(listener)`

`(listener: (fact: Sequenced<TEvent>) => void) => () => void`

Synchronously subscribes to newly committed facts. It is live-only and does not
replay retained facts. The state projection is committed before the listener
receives its corresponding fact. Returns a synchronous, idempotent unsubscribe
function.

### `Sequenced<TEvent>`

```ts
interface Sequenced<TEvent> {
  readonly sequence: number;
  readonly event: TEvent;
}
```

The journal wrapper pairing a domain event with its store-assigned gapless
sequence. Domain events stay free of store machinery.

## Examples

### Fine-grained selection of a nested value

Invalidation is per top-level key, but notification is per selected value: a
selector over a deep leaf re-runs cheaply when anything under its key changes
and notifies only when the leaf itself changed.

```ts
const theme = Store.defineSlice({
  name: "theme",
  initial: { settings: { colors: { accent: "blue", neutral: "slate" }, radius: 4 } },
  decide: /* ... */,
  reduce: /* ... spread-updates that preserve untouched branches ... */,
});

const program = Effect.gen(function* () {
  const store = yield* Store.make(theme);

  const accent = store.select(() => store.read("settings").colors.accent);

  // Changing radius or neutral re-runs the selector (a few property reads)
  // but notifies nobody: the accent value did not change.
  yield* store.dispatch(ThemeCommand.RadiusChanged({ radius: 8 }));

  // Changing accent notifies accent consumers exactly once.
  yield* store.dispatch(ThemeCommand.AccentChanged({ accent: "green" }));

  console.log(accent()); // "green"
});
```

### Cascading commands from a listener

Listeners may dispatch. The command joins a FIFO queue and applies before the
boundary dispatch returns, with its events journaled after the triggering
command's events:

```ts
const program = Effect.gen(function* () {
  const store = yield* Store.make(settings);

  const unsubscribe = store.subscribe("baz", (baz) => {
    // Enqueue-ack: applied before the outer dispatch returns,
    // but not yet visible right here.
    Effect.runSync(store.dispatch(SettingsCommand.FooChanged({ foo: `saw-${baz}` })));
  });

  yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));

  // Both the trigger and the cascade have applied, in order.
  console.log(store.read("baz")); // "bat"
  console.log(store.read("foo")); // "saw-bat"

  unsubscribe();
});
```

### Observing the journal

Every accepted fact is retained and streamed, which makes logging, devtools,
and replay-style assertions one-liners:

```ts
const program = Effect.gen(function* () {
  const store = yield* Store.make(settings);

  yield* store.journalChanges.pipe(
    Stream.runForEach((fact) => Effect.log(`[${fact.sequence}] ${fact.event._tag}`)),
    Effect.forkScoped,
  );

  yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));

  // The fold invariant: replaying the journal always reproduces state.
  const journal = yield* store.journal;
  const replayed = journal.map(({ event }) => event).reduce(settings.reduce, settings.initial);
  console.log(replayed); // equals yield* store.state
});
```

## Guarantees

- **Fold invariant**: `fold(initial, journal)` always equals the current
  snapshot. Requested-but-rejected commands (where `decide` returned `[]`)
  never touch the journal.
- **Fault-atomic dispatch**: all events are folded before facts are appended. A
  reducer defect appends no facts, publishes no state or journal stream values,
  and sends no keyed, selector, or journal notifications.
- **Fine-grained notification**: a subscriber of one key never fires when only
  other keys change, and never fires for value-identical writes.
- **Synchronous boundary**: `Effect.runSync(store.dispatch(...))` returns with
  all subscribers notified and all listener-dispatched cascades applied
  (run-to-quiescence).
- **Serialized writes**: concurrent dispatches apply one at a time with
  gapless monotonic sequences.
- **Loud failure over silence**: non-converging listener cascades fail with a
  defect naming the store; nothing spins or freezes silently.
