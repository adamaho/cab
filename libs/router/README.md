# @cab/router

`@cab/router` is the navigation library for cab applications.

It gives applications a small, typed API for changing routes, observing the
current route, and inspecting the navigation facts that led to the current
state. The package is built on Effect and is designed to be consumed from shell
applications and UI adapters.

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

`@cab/router` keeps that context available.

Each navigation request is recorded as a fact. Successful and failed outcomes
are recorded as facts too. The current route is then derived from those facts.
That gives consumers a simple model:

```text
navigate -> journal facts -> current state
```

This is useful for people, tests, and coding agents. An agent can navigate by
dispatching one typed command, observe the emitted journal facts, read the
projected state, and decide what to do next from concrete feedback instead of
guessing from the DOM alone.

## Current Scope

This package currently supports programmatic navigation to an href and observing
browser back/forward navigation.

It intentionally does not yet provide:

- route matching
- route params
- loaders or actions
- redirects
- guards or blockers
- scroll restoration

Those features can be added later without changing the core consumer model:
navigation remains facts plus projected state.

## Installation

Inside this workspace, add the router to a shell or feature package:

```bash
pnpm --filter=@cab/shell-playground add @cab/router@workspace:*
```

For Solid UI bindings, add the Solid atom adapter in the shell package:

```bash
pnpm --filter=@cab/shell-playground add @effect/atom-solid@catalog:
```

`@cab/router` depends on `effect`, which is managed through the workspace
catalog.

## Core Concepts

### State

State is the current route projection:

```ts
interface RouterState {
  readonly href: string;
}
```

Use state when rendering the current route or showing the current href.

### Journal

The journal is the retained list of navigation facts for the current router
session.

Current event variants are:

```text
NavigationRequested
NavigationCommitted
NavigationObserved
NavigationFailed
```

Use the journal for debugging, diagnostics, tests, and agent feedback.

### Commands

Commands represent caller intent. Today there is one command:

```text
NavigationRequested({ href })
```

Most consumers should use `router.navigate(href)`. Use `router.dispatch(...)`
when command-shaped input is useful.

## Router Service API

```ts
interface RouterShape {
  readonly dispatch: (command: RouterCommand) => Effect.Effect<void>;
  readonly navigate: (href: string) => Effect.Effect<void>;
  readonly state: Effect.Effect<RouterState>;
  readonly stateChanges: Stream.Stream<RouterState>;
  readonly journal: Effect.Effect<ReadonlyArray<RouterEvent>>;
  readonly journalChanges: Stream.Stream<RouterEvent>;
}
```

Use these fields as follows:

- `navigate` changes the browser route to an href.
- `dispatch` accepts typed router commands.
- `state` reads the current route state.
- `stateChanges` streams the initial state and later committed or observed state
  changes.
- `journal` reads the retained navigation facts.
- `journalChanges` streams newly appended navigation facts after subscription.

`journalChanges` is live-only. It does not replay old events to new
subscribers. Use `journal` when you need the retained history.

## Basic Usage

### Navigate And Read State

```ts
import { Effect } from "effect";
import { Router } from "@cab/router";

const program = Effect.gen(function* () {
  const router = yield* Router;

  yield* router.navigate("/settings");

  return yield* router.state;
});

const state = await Effect.runPromise(Effect.provide(program, Router.layerBrowser));

console.log(state.href); // "/settings"
```

`Router.layerBrowser` wires the router to browser history.

Browser back/forward navigation is observed through `popstate`. When the browser
location changes outside `router.navigate` or `router.dispatch`, the router
appends a `NavigationObserved` fact and updates projected state to the observed
href.

### Dispatch A Command

```ts
import { Effect } from "effect";
import { Router, RouterCommand } from "@cab/router";

const program = Effect.gen(function* () {
  const router = yield* Router;

  yield* router.dispatch(RouterCommand.NavigationRequested({ href: "/billing" }));
});
```

### Observe State Changes

```ts
import { Effect, Stream } from "effect";
import { Router } from "@cab/router";

const program = Effect.gen(function* () {
  const router = yield* Router;

  yield* router.stateChanges.pipe(
    Stream.tap((state) => Effect.sync(() => console.log("href", state.href))),
    Stream.runDrain,
  );
});
```

Route rendering should normally depend on `state` or `stateChanges`.

### Observe Navigation Facts

```ts
import { Effect, Stream } from "effect";
import { Router } from "@cab/router";

const program = Effect.gen(function* () {
  const router = yield* Router;

  yield* router.journalChanges.pipe(
    Stream.tap((event) => Effect.sync(() => console.log("[router:event]", event))),
    Stream.runDrain,
  );
});
```

This is useful for debugging, devtools, analytics, integration tests, and agent
feedback loops.

## Solid Usage

`@cab/router` exports framework-agnostic Effect atoms:

```ts
import { routerNavigateAtom, routerRuntimeAtom, routerStateAtom } from "@cab/router";
```

Solid shells can consume those atoms with `@effect/atom-solid`:

```tsx
import { RegistryProvider, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-solid";
import { routerNavigateAtom, routerRuntimeAtom, routerStateAtom } from "@cab/router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

export function App() {
  return (
    <RegistryProvider>
      <Routes />
    </RegistryProvider>
  );
}

function Routes() {
  useAtomMount(() => routerRuntimeAtom);

  const state = useAtomValue(() => routerStateAtom);
  const navigate = useAtomSet(() => routerNavigateAtom);

  return (
    <main>
      <p>Current href: {AsyncResult.isSuccess(state()) ? state().value.href : "loading..."}</p>
      <button onClick={() => navigate("/settings")} type="button">
        Settings
      </button>
    </main>
  );
}
```

`routerStateAtom` is backed by a long-lived stream. Treat
`AsyncResult.isSuccess(state())` as the signal that router state is available.
Do not use the `waiting` flag as a loading indicator for router state.

## Testing With Memory History

Use `MemoryHistory.make` to test the router without a browser.

```ts
import { Effect, Layer } from "effect";
import { MemoryHistory, Router } from "@cab/router";

const program = Effect.gen(function* () {
  const memory = yield* MemoryHistory.make("/");

  const result = yield* Effect.provide(
    Effect.gen(function* () {
      const router = yield* Router;

      yield* router.navigate("/settings");
      yield* memory.observe("/account");

      return {
        state: yield* router.state,
        journal: yield* router.journal,
      };
    }),
    Router.layer.pipe(Layer.provide(memory.layer)),
  );

  return {
    ...result,
    pushedHrefs: yield* memory.pushes,
  };
});
```

`memory.observe(href)` simulates browser-originated navigation such as
back/forward. It updates the memory location and emits a history change without
recording a push.

## Behavior Guarantees

- Navigating to the current href is a silent no-op.
- Non-deduped navigations append a requested event and one outcome event.
- Successful navigation updates browser history and projected state.
- Failed navigation records a failed event and leaves projected state unchanged.
- Browser back/forward navigation appends an observed event and updates projected
  state.
- Observed navigation to the current href is a silent no-op.
- Concurrent navigations are processed one at a time.
- `journalChanges` emits facts in journal order.
- `stateChanges` emits the seeded state and later committed or observed state
  changes.

## When To Use The Journal

Use route state for rendering. Use the journal when you need context.

Good journal use cases:

- debugging a navigation issue
- displaying a development timeline
- recording navigation diagnostics
- observing failed navigation attempts
- waiting for a specific event in a test
- giving a coding agent feedback about what happened after it navigated

Avoid using the journal as the primary rendering model. The state projection is
the rendering API; the journal is the explanation of how that state came to be.
