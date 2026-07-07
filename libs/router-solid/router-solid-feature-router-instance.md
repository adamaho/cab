# Router Solid Feature: Opaque Router Instance

## Setpoint

`@cab/router-solid` should expose a router instance that feels like the owner of
the router's state, actions, and provider lifetime without making application
consumers understand Effect atoms.

Applications should keep using plain Solid-facing APIs:

```tsx
import {
  createBrowserRouter,
  RouterProvider,
  useRouterNavigate,
  useRouterState,
} from "@cab/router-solid";
import { RegistryProvider } from "@effect/atom-solid";

const router = createBrowserRouter({
  onEvent: (event) => console.log("[router:event]", event),
});

export function App() {
  return (
    <RegistryProvider>
      <RouterProvider router={router}>
        <Routes />
      </RouterProvider>
    </RegistryProvider>
  );
}

function Routes() {
  const state = useRouterState();
  const navigate = useRouterNavigate();

  return <button onClick={() => navigate("/settings")}>{state().href}</button>;
}
```

## Why This Exists

The current implementation hides internal atoms behind a `WeakMap` and an
`internalsOf(router)` lookup. That is technically honest: TypeScript interfaces
cannot have private fields, so a public `{ atom }` object needs either a cast or
a side table to reach private atom wiring from provider and hooks.

The side table works, but it makes the hiding mechanism visible in the package
implementation. The next design question is whether the router instance itself
can own the implementation state directly, closer to a TanStack Router-style
mental model, while still keeping atoms out of the consumer-facing API.

## Decisions

- Do not expose a public `lifecycle` atom.
- Do not expose `runtimeAtom`, `stateAtom`, `navigateAtom`, or `dispatchAtom` as
  documented public fields by default.
- Keep atoms as an implementation detail of `@cab/router-solid` unless there is
  a concrete cross-library composition use case that needs a public atom handle.
- Treat `RouterProvider` as the owner of the router instance lifetime in Solid.
- Keep module-level hooks as the primary consumer API.
- Expose `useRouter()` so advanced consumers and future hooks can access the
  current router instance without reaching into private internals.
- Let `useRouterState` accept a selector so components can subscribe to the
  state slice they render instead of always reading the full router state.
- Let the router instance encapsulate the internal reactive wiring, but expose
  plain Solid-friendly behavior through provider and hooks.
- Keep `onEvent` as the deliberate observability escape hatch for logging,
  devtools, and analytics instead of exposing a journal atom.

## What Lifecycle Means

The word `lifecycle` only describes an internal need: while a `RouterProvider` is
mounted, the adapter must keep the core router runtime, history observation, the
state projection stream, and optional `onEvent` journal tap alive even if no
component is currently reading router state.

That is not a product concept and should not be part of the public API. A
consumer should think in terms of mounting a router provider, not mounting a
lifecycle atom.

## Preferred Internal Shape

Replace the exported `SolidRouter` interface plus `WeakMap` with an exported
class that owns a private implementation record. Keep atom details private, but
model the instance as a capability object instead of a public atom bag:

```ts
export class SolidRouter {
  readonly #impl: SolidRouterImpl;

  /** @internal Called by RouterProvider to keep the router instance alive. */
  static mountProvider(router: SolidRouter): void;

  /** @internal Called by useRouterState. */
  static useState<TSelected>(
    router: SolidRouter,
    options?: { readonly select?: (state: RouterState) => TSelected },
  ): Accessor<RouterState | TSelected>;

  /** @internal Called by useRouterNavigate. */
  static useNavigate(router: SolidRouter): (href: string) => void;

  /** @internal Called by useRouterDispatch. */
  static useDispatch(router: SolidRouter): (command: RouterCommand) => void;
}

interface SolidRouterImpl {
  readonly initialState: RouterState;
  readonly runtimeAtom: Atom.AtomRuntime<Router, HistoryError>;
  readonly stateAtom: Atom.Atom<AsyncResult.AsyncResult<RouterState, RouterStateError>>;
  readonly navigateAtom: Atom.AtomResultFn<string, void, HistoryError>;
  readonly dispatchAtom: Atom.AtomResultFn<RouterCommand, void, HistoryError>;
  readonly journalTapAtom?: Atom.Atom<AsyncResult.AsyncResult<RouterEvent, RouterStateError>>;
}
```

This is more Effect-shaped than exposing raw fields because the instance is a
capability object: provider and hooks ask the router to perform Solid binding
work, while the underlying atom/runtime resources stay private. The class is
still useful because ECMAScript private fields give real runtime privacy without
the `WeakMap` side table.

Prefer static internal helpers over instance methods named `useState` or
`useNavigate`. TanStack's public router instance owns real router capabilities,
while framework hooks are separate functions over context. Static helpers keep
that separation clearer: consumers see `useRouterState` and
`useRouterNavigate`, while the package implementation gets a typed path to the
private fields.

Do not add an instance-level `useAsyncState` method unless a consumer-facing API
needs it. The primary hook can stay total (`useRouterState`), and error or
loading visibility can be reconsidered separately if the UI needs it.

## TanStack Router Reference Notes

TanStack Solid Router is much larger than this slice, but its package boundary
offers useful design pressure:

- `createRouter(options)` returns a router instance, and hooks read that instance
  from context. The router instance is the identity boundary.
- `RouterProvider` provides the router instance, and a lower-level context
  provider exists separately from the provider that renders matches.
- `useRouter()` is public and is the foundation for other hooks.
- `useRouterState({ select })` supports selecting a derived state slice instead
  of always returning the whole state.
- Solid reactivity is hidden inside a framework store factory; consumers do not
  import or wire the underlying reactive primitives directly.
- Navigation hooks are thin wrappers around router capabilities rather than
  standalone global state.

For `@cab/router-solid`, the near-term translation is: add public `useRouter`,
add selector support to `useRouterState`, keep atoms hidden, and keep provider
and hooks as thin adapters over the router instance. Route matching, links,
matches, route context, and SSR concerns remain deferred.

## Public API Shape

The package entrypoint should continue to expose:

```ts
createBrowserRouter(options?: RouterOptions): SolidRouter;

createMemoryRouter(options: RouterOptions & {
  readonly initialHref: string;
}): Effect.Effect<MemoryRouter>;

RouterProvider(props: {
  readonly router: SolidRouter;
  readonly children?: JSX.Element;
}): JSX.Element;

useRouter(): SolidRouter;
useRouterState(): Accessor<RouterState>;
useRouterState<TSelected>(options: {
  readonly select: (state: RouterState) => TSelected;
}): Accessor<TSelected>;
useRouterNavigate(): (href: string) => void;
useRouterDispatch(): (command: RouterCommand) => void;
```

`createBrowserRouter` is synchronous because it only returns the router instance.
`createMemoryRouter` is effectful because tests need the separately allocated
`MemoryHistory` handle for assertions and external navigation simulation.

`RouterStateError` is a local alias for the current atom error channel:

```ts
type RouterStateError = HistoryError | Cause.NoSuchElementError;
```

## Non-Goals

- Do not add route matching, params, links, outlets, loaders, guards, blockers,
  scroll restoration, or route definitions in this slice.
- Do not expose a public atom bundle as the default next step.
- Do not introduce direct `router.navigate(href)` outside Solid owner/registry
  lifetime yet. That would require deciding whether the router instance owns a
  non-atom Effect runtime in addition to the Solid atom bindings.
- Do not add a public journal hook unless a concrete UI use case appears.
- Do not implement TanStack-style route trees, matches, route context, pending
  components, error boundaries, links, or SSR hydration in this slice.

## Implementation Steps

1. Replace the exported `SolidRouter` interface with an exported class that owns
   private atom fields.
2. Move the current `make(...)` construction logic into the class constructor or
   a private factory helper.
3. Delete the `WeakMap`, `RouterInternals`, and `internalsOf` lookup.
4. Update `RouterProvider` to call a router instance method that mounts the
   provider-owned runtime/state/journal lifetime.
5. Rename `useNavigate` to `useRouterNavigate` in docs, exports, tests, and the
   playground.
6. Add `useRouter()` and make the existing hooks derive the router from it.
7. Add `useRouterState({ select })` support with stable derived values where
   practical.
8. Update hooks to delegate to router instance helpers instead of reading
   internal atoms.
9. Update tests to stop importing `internalsOf` and to exercise behavior through
   provider/hooks or through intentionally public router methods only.
10. Add hardening tests for the already-promised behavior: total state accessor
    fallback, dispatch hook behavior, `createBrowserRouter` smoke behavior, and
    `onEvent` delivery.

## Stability Rules

- Consumers should not need to import `effect/unstable/reactivity/Atom` or
  `@effect/atom-solid` hooks directly to use the router.
- `RouterProvider` must not create an `AtomRegistry`; the application root owns
  registry lifetime.
- A router instance should not be swapped after provider setup. The
  implementation should either capture the initial router once or fail loudly on
  swaps.
- Keep the next change small: remove `internalsOf` and preserve behavior before
  adding new routing features.

## PID Sensors

Focused sensors:

- `pnpm fmt`
- `pnpm fmt:check`
- `pnpm --filter=@cab/router-solid run tsc`
- `pnpm --filter=@cab/router-solid run lint`
- `pnpm --filter=@cab/router-solid run test:unit`

Close-out sensors:

- `pnpm tsc`
- `pnpm lint`
- `pnpm turbo run test:unit`
