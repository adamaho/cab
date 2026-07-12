# @cab/router-solid

`@cab/router-solid` is the Solid adapter for `@cab/router`.

It gives Solid applications a small, typed API for creating a router instance,
providing it at the application root, reading the current route, and dispatching
navigation without importing Effect runtime details directly. Browser router
construction is synchronous: the real model exists before any provider mounts.
Synchronous state therefore has no startup window. The package is built on
`@cab/router`, `@cab/store`, `effect`, and Solid.

## Why This Exists

Navigation state should be easy to render from Solid components without making
application code understand the router service runtime or store bridge wiring.

`@cab/router` keeps the framework-agnostic model:

```text
navigate -> journal facts -> current state
```

`@cab/router-solid` owns the Solid integration for that model:

```text
Solid component -> hooks -> RouterProvider -> @cab/router -> History
```

This keeps the store bridge as an adapter internal while giving applications
plain Solid-facing hooks for route state and navigation.

## Current Scope

This package currently supports creating browser-backed and memory-backed router
instances, providing a router through Solid context, reading route state, and
navigating to an href.

It intentionally does not yet provide:

- route matching
- route params
- `<Link>`
- outlets or route rendering
- loaders or actions
- redirects
- guards or blockers
- scroll restoration

Those features can be added later without changing the adapter boundary: the
router instance owns the reactive wiring, and components consume state and
navigation through hooks.

## Installation

Inside this workspace, add the Solid router adapter to a shell package:

```bash
pnpm --filter=@cab/shell-playground add @cab/router-solid@workspace:*
```

`@cab/router-solid` depends on `@cab/router`, `@cab/store`, `effect`, and
`solid-js`, which are managed through the workspace and catalog.

## Core Concepts

### Router Instance

A `SolidRouter` is the adapter-owned router instance created by
`createBrowserRouter` or `createMemoryRouter`.

The instance owns one stable model and its internal reactive wiring.
Applications pass it to `RouterProvider`; hooks read the current instance from
context. `SolidRouter` has no public constructor or `make` method.

```ts
const router = createBrowserRouter();
```

### Provider

`RouterProvider` provides a `SolidRouter` instance to the component tree and
keeps the router runtime mounted for the lifetime of the provider.

`RouterProvider` owns one mounted process lifetime. Unmounting disposes that
runtime, its history listener, and mounted subscriptions, but preserves the
router's state, retained journal, sequence, and reader. The same instance can be
remounted sequentially and reconciles the then-current history location.

Concurrent mounts of one instance are rejected, as are nested providers.
Functions returned by navigation or dispatch hooks belong to the mount that
created them and throw if called after unmount, including after a later remount.

### State

State is the current route projection from `@cab/router`:

```ts
interface RouterState {
  readonly href: string;
}
```

Use `useRouterState()` when rendering the current href. Pass `select` when a
component only needs a derived slice.

### Navigation

Use `useRouterNavigate()` for the common navigation case. It returns a function
that accepts an href and returns `void`.

Navigation failures are recorded by the core router as journal facts. They are
not thrown to UI callers.

### Events

Pass `onEvent` when creating a router to observe the journal facts that occur
while the provider is mounted.

Use this for console logging, devtools, analytics, and test feedback. The
callback receives new facts in ascending order, live-only for each mounted
lifetime; facts produced while unmounted are retained but not replayed.
Callback failures are reported and isolated so they cannot fail dispatch or
stop later delivery. The retained journal remains part of `@cab/router` for
Effect-land consumers.

## Solid Adapter API

```ts
interface RouterOptions {
  readonly onEvent?: (event: Sequenced<RouterEvent>) => void;
}

createBrowserRouter(options?: BrowserRouterOptions): SolidRouter;

interface BrowserRouterOptions extends RouterOptions {
  readonly initialHref?: string;
}

createMemoryRouter(options: RouterOptions & {
  readonly initialHref: string;
}): Effect.Effect<MemoryRouter>;

interface MemoryRouter {
  readonly router: SolidRouter;
  readonly history: MemoryHistory;
}

RouterProvider(props: {
  readonly router: SolidRouter;
  readonly children?: JSX.Element;
}): JSX.Element;

useRouter(): SolidRouter;

useRouterState(): Accessor<RouterState>;

useRouterState<TSelected>(options: {
  readonly select: (state: RouterState) => TSelected;
  readonly equals?: (a: TSelected, b: TSelected) => boolean;
}): Accessor<TSelected>;

useRouterNavigate(): (href: string) => void;

useRouterDispatch(): (command: RouterCommand) => void;
```

Use these fields as follows:

- `createBrowserRouter` synchronously creates a browser-backed router model. It
  uses `initialHref` when provided, otherwise the current browser location or
  `"/"` outside a browser.
- `createMemoryRouter` creates a memory-backed router and returns the memory
  history handle for tests.
- `RouterProvider` provides the router instance and mounts a replaceable runtime
  lifetime around its stable model.
- `useRouter` reads the current router instance from context.
- `useRouterState` reads the current route state as a total Solid accessor.
- `useRouterState({ select, equals })` executes the selector inside the store,
  dynamically tracks the top-level keys it reads, and uses `equals` to
  deduplicate selected output when provided (`Object.is` by default).
- `useRouterNavigate` returns an href navigation function.
- `useRouterDispatch` returns a typed command dispatch function.

## Basic Usage

### Provide A Browser Router

```tsx
import {
  createBrowserRouter,
  RouterProvider,
  useRouterNavigate,
  useRouterState,
} from "@cab/router-solid";

const router = createBrowserRouter({
  onEvent: (event) => console.log("[router:event]", event),
});

export function App() {
  return (
    <RouterProvider router={router}>
      <Routes />
    </RouterProvider>
  );
}

function Routes() {
  const state = useRouterState();
  const navigate = useRouterNavigate();

  return (
    <main>
      <p>Current href: {state().href}</p>
      <button onClick={() => navigate("/settings")} type="button">
        Settings
      </button>
    </main>
  );
}
```

`createBrowserRouter` creates the real folded model synchronously from the
current browser location, so state exists before mount and
`useRouterState()` always has a `RouterState` to return.

### Server Rendering

Pass `initialHref` to render a request URL without touching `window`:

```tsx
const router = createBrowserRouter({ initialHref: request.url });
```

Outside a browser, the default initial href is `"/"`. A server-mounted provider
installs context and selector ownership only: it does not create an Effect
runtime, acquire browser history, or deliver `onEvent`. Navigation callbacks
require an active browser mount and throw descriptively on the server. On the
client, mounting reconciles the model with the actual browser href.

### Select State

```tsx
import { useRouterState } from "@cab/router-solid";

function CurrentHref() {
  const href = useRouterState({ select: (state) => state.href });

  return <p>Current href: {href()}</p>;
}
```

Use `select` when a component only needs one derived value from the router state.
The selector executes inside `@cab/store`; only the top-level state keys it reads
become dependencies. Its dependencies are rediscovered when it reruns, and
custom `equals` controls selected-output notification.

### Dispatch A Command

```tsx
import { RouterCommand } from "@cab/router";
import { useRouterDispatch } from "@cab/router-solid";

function BillingButton() {
  const dispatch = useRouterDispatch();

  return (
    <button
      onClick={() => dispatch(RouterCommand.NavigationRequested({ href: "/billing" }))}
      type="button"
    >
      Billing
    </button>
  );
}
```

Most UI should use `useRouterNavigate`. Use `useRouterDispatch` when
command-shaped input is useful.

## Testing With Memory History

Use `createMemoryRouter` to test Solid components without a browser history
service.

```tsx
import { render, waitFor } from "@solidjs/testing-library";
import { Effect } from "effect";
import { createMemoryRouter, RouterProvider, useRouterState } from "@cab/router-solid";

function Probe() {
  const state = useRouterState();

  return <span data-testid="href">{state().href}</span>;
}

const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));

const screen = render(() => (
  <RouterProvider router={memory.router}>
    <Probe />
  </RouterProvider>
));

await Effect.runPromise(memory.history.simulate("/external"));

await waitFor(() => {
  expect(screen.getByTestId("href").textContent).toBe("/external");
});
```

`memory.history.simulate(href)` simulates browser-originated navigation such as
back/forward. It updates the memory location and emits a history change without
recording a push.

## Behavior Guarantees

- One router instance owns one independent set of reactive router wiring.
- Two router instances remain independent.
- `createBrowserRouter` returns synchronously with the real model already
  available; mounting does not replace its reader or state.
- `RouterProvider` owns and disposes each mounted runtime lifetime while model
  state and journal survive unmount.
- Sequential remount is supported; concurrent mounts of one instance throw.
- Nested `RouterProvider` instances throw; provide one router at the application
  root.
- Hook callbacks captured from an old mount throw after unmount and cannot
  dispatch into a later mount.
- `useRouterState()` always returns the real folded projection.
- `useRouterState({ select, equals })` returns the selected state slice and
  runs dynamic dependency tracking and selected-output equality in the store.
- `useRouterNavigate()` returns `void`; navigation failures are journal facts.
- `useRouterDispatch()` dispatches typed router commands.
- Browser back/forward navigation updates rendered state through the core router.
- `onEvent` receives live navigation facts while the provider is mounted;
  failures are isolated and facts from unmounted gaps are not replayed.

## When To Use Events

Use route state for rendering. Use `onEvent` when you need context.

Good event use cases:

- debugging a navigation issue
- displaying a development timeline
- recording navigation diagnostics
- observing failed navigation attempts
- waiting for a specific event in a test
- giving a coding agent feedback about what happened after it navigated

Avoid using events as the primary rendering model. The state accessor is the
rendering API; events are the explanation of how that state came to be.
