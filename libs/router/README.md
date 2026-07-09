# @cab/router

`@cab/router` is the event-sourced navigation library for cab applications.

Writes go through a navigation saga: user intent is dispatched as a command,
the saga performs the browser history mutation, and every step — requested,
committed, observed, failed — is recorded as a sequenced journal fact. Reads
come from a store reader: the current route projection, live streams of state
and facts, and fine-grained reactive reads. The package is framework-agnostic
and built on `effect` and `@cab/store`.

## Why This Exists

Navigation is one of the easiest parts of an application to make implicit. A
button changes the URL, some reactive state updates, and the facts that caused
the transition disappear. That is convenient until a developer or coding agent
needs to answer basic questions:

- What navigation was requested?
- Did the browser URL update succeed?
- What route does the application believe it is on now?
- What happened immediately before this state?
- Did concurrent navigation requests run in a predictable order?

`@cab/router` keeps that context available. It is a slice on `@cab/store`:

```text
you own (as a consumer): dispatching intent, observing state and facts
the router owns:         the history I/O saga, dedup rules, the fold
the store owns:          journaling, sequencing, serialization, reactivity
```

This is useful for people, tests, and coding agents. An agent navigates by
dispatching one typed command, monitors the emitted journal facts, reads the
projected state, and decides what to do next from concrete feedback instead of
guessing from the DOM.

## Current Scope

Programmatic navigation to an href, observation of browser back/forward
navigation, and full navigation history as journal facts.

It intentionally does not yet provide:

- route matching or route params
- loaders, actions, or redirects
- guards or blockers
- scroll restoration
- back/forward commands (planned; requires growing the history surface)

Those features can be added without changing the consumer model: navigation
remains commands in, facts and projected state out.

## Installation

Inside this workspace, add the router to a shell or feature package:

```bash
pnpm --filter=@cab/your-package add @cab/router@workspace:*
```

`@cab/router` depends on `effect` and `@cab/store`, both managed through the
workspace. Solid applications should render route state through the
`@cab/router-solid` adapter rather than consuming this package directly.

## Quick Start

Navigate, read the projection, and inspect the facts that produced it:

```ts
import { Effect } from "effect";
import { Router } from "@cab/router";

const program = Effect.gen(function* () {
  const router = yield* Router;

  yield* router.navigate("/settings");

  const state = yield* router.reader.state;
  console.log(state.href); // "/settings"

  console.log(yield* router.reader.journal);
  // [
  //   { sequence: 0, event: { _tag: "NavigationRequested", href: "/settings" } },
  //   { sequence: 1, event: { _tag: "NavigationCommitted", href: "/settings" } },
  // ]

  // Navigating to the current href is a silent no-op: decide rejects it,
  // nothing is journaled, no history push happens.
  yield* router.navigate("/settings");
});

await Effect.runPromise(Effect.provide(program, Router.layerBrowser));
```

`Router.layerBrowser` wires the router to browser history. Browser
back/forward is observed through `popstate`: when the location changes outside
the router, a `NavigationObserved` fact is appended and the projection updates.

## Core Concepts

### Commands In, Facts Out

`RouterCommand` is caller intent — today a single case,
`NavigationRequested({ href })`. Dispatching it runs the navigation saga:
record the request, perform `history.push`, record the outcome.

`RouterEvent` is the journal fact vocabulary:

```text
NavigationRequested   accepted caller intent
NavigationCommitted   the history mutation succeeded
NavigationObserved    the browser navigated on its own (back/forward)
NavigationFailed      the history mutation failed (with a reason)
```

Outcome facts cannot be fabricated: public `dispatch` accepts only
`RouterCommand`, and the outcome command constructors never leave the package.
A `NavigationCommitted` in the journal means a history mutation really
happened. This holds at the type level, not by convention.

### The Reader

All reads live on `router.reader`, a `StoreReader<RouterState, RouterEvent>`
from `@cab/store`: Effect-land views (`state`, `stateChanges`, `journal`,
`journalChanges`) plus synchronous fine-grained reactive reads (`read`,
`select`, `subscribe`). Writes live on the service (`navigate`, `dispatch`).
There is no way to modify router state through the reader.

### State Versus Journal

Use the state projection (`{ readonly href: string }`) for rendering. Use the
journal when you need context: debugging a navigation issue, recording
diagnostics, waiting for a specific fact in a test, or giving a coding agent
feedback about what happened after it navigated. The projection is the
rendering API; the journal is the explanation of how it came to be.

## Public API

### `Router` / `Router.layer` / `Router.layerBrowser`

The Effect service tag and its layers. `Router.layer` requires a `History`
service; `Router.layerBrowser` provides the `window.history`-backed one.
Construction seeds the projection from the history service's current href.

### `router.navigate(href)`

`(href: string) => Effect.Effect<void>`

Dispatches a navigation request for the href. Returns `void` by design:
failures are recorded as `NavigationFailed` facts, not thrown, so there is
nothing to await or catch. Navigating to the current href is a silent no-op.

### `router.dispatch(command)`

`(command: RouterCommand) => Effect.Effect<void>`

The command-shaped entrance to the same saga. Accepts user-originated
`RouterCommand` only — outcome commands are saga-internal and rejected at the
type level.

### `router.reader`

`StoreReader<RouterState, RouterEvent>` — see the `@cab/store` README for the
full contract of each member. In router terms:

- `state` reads the current `{ href }` projection.
- `stateChanges` streams the seeded projection and each later change
  (committed or observed navigation; requested and failed facts leave state
  untouched and do not emit).
- `read("href")` is a synchronous reactive read, trackable inside signal
  computations.
- `select(fn)` derives a memoized reactive value over reads.
- `subscribe("href", cb)` fires on change only and returns unsubscribe.
- `journal` reads the retained facts as `Sequenced<RouterEvent>`.
- `journalChanges` streams newly appended facts, live-only — use `journal`
  for retained history.

### `RouterState` / `RouterCommand` / `RouterEvent`

The projection type, the user command constructors, and the journal fact
constructors (`Data.taggedEnum` bundles with `$match`/`$is`). Journal entries
wrap events as `Sequenced<RouterEvent>` — import `Sequenced` from
`@cab/store`.

### `RouterSlice.make(href)` / `initial(href)`

The slice definition factory and initial-projection helper. Application code
rarely needs these; they exist for the adapter package, tests, and fold
assertions (`journal.map(({ event }) => event).reduce(slice.reduce, initial(href))`).

### History surface

`History` (service tag), `WindowHistory.layer`, `MemoryHistory.make(href)`,
and `HistoryError`/`HistoryErrorReason`. `MemoryHistory` is the in-memory
test double: `pushes` records router-owned navigation for assertions and
`observe(href)` simulates browser-originated navigation.

## Examples

### Observing navigation facts

Useful for debugging, devtools, analytics, integration tests, and agent
feedback loops:

```ts
import { Effect, Stream } from "effect";
import { Router } from "@cab/router";

const program = Effect.gen(function* () {
  const router = yield* Router;

  yield* router.reader.journalChanges.pipe(
    Stream.runForEach((fact) =>
      Effect.log(`[router:${fact.sequence}] ${fact.event._tag} -> ${fact.event.href}`),
    ),
    Effect.forkScoped,
  );

  yield* router.navigate("/billing");
  // [router:0] NavigationRequested -> /billing
  // [router:1] NavigationCommitted -> /billing
});
```

### Fine-grained reactive reads

The reader's synchronous surface is what framework adapters build on — one
subscription per key, change-only:

```ts
const router = yield * Router;

const unsubscribe = router.reader.subscribe("href", (href) => {
  console.log("navigated to", href);
});

const section = router.reader.select(() => router.reader.read("href").split("/")[1]);

yield * router.navigate("/settings/profile");
console.log(section()); // "settings"

unsubscribe();
```

### Testing with memory history

`MemoryHistory.make` runs the router without a browser:

```ts
import { Effect, Layer } from "effect";
import { MemoryHistory, Router } from "@cab/router";

const program = Effect.gen(function* () {
  const memory = yield* MemoryHistory.make("/");

  const result = yield* Effect.provide(
    Effect.gen(function* () {
      const router = yield* Router;

      yield* router.navigate("/settings");
      yield* memory.observe("/account"); // simulate browser back/forward

      return {
        state: yield* router.reader.state,
        journal: yield* router.reader.journal,
      };
    }),
    Router.layer.pipe(Layer.provide(memory.layer)),
  );

  console.log(result.state); // { href: "/account" }
  console.log(yield* memory.pushes); // ["/settings"] — observe() records no push
});
```

## Guarantees

- **Facts never lie**: outcome facts can only be produced by the saga after a
  real history outcome; consumers cannot fabricate them (type-level).
- **Fold invariant**: replaying the journal over `initial(seedHref)` always
  reproduces the current projection.
- **Dedup**: navigating or observing to the current href appends nothing,
  notifies nobody, and never touches browser history.
- **Accepted navigation is two facts**: one requested fact plus exactly one
  outcome fact (committed or failed). Failed navigation leaves the projection
  unchanged.
- **External navigation is observed**: browser back/forward appends a
  `NavigationObserved` fact and updates the projection.
- **Serialized sagas**: concurrent navigations process one at a time; journal
  facts appear in journal order with gapless sequences.
- **Change-only streams**: `stateChanges` emits only when the projection
  actually changed; journal-only facts (requested, failed) do not emit.
