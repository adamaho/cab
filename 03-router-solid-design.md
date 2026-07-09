# Router Solid Design: Rewrite `@cab/router-solid` On The Store Bridge

Slice 3 of the store foundation series. Prerequisites: `@cab/store` (shipped,
`libs/store/README.md`) and the `@cab/router` rewrite (shipped in the working
tree, `libs/router/README.md`) — both green. This slice closes the designed
repo-wide `tsc` breakage window (`@cab/router-solid` is currently the only red
package) and carries the small `shells/playground` update, since the adapter
rewrite removes the registry requirement.

## Router Facts This Design Relies On

The shipped `@cab/router` semantics that shape this rewrite:

- **`RouterShape` is `{ dispatch, navigate, reader }`.** All reads live on
  `router.reader: StoreReader<RouterState, RouterEvent>`: Effect-land views
  (`state`, `stateChanges`, `journal`, `journalChanges`) plus the synchronous
  reactive surface this adapter bridges (`read`, `select`, `subscribe`).
- **`subscribe(key, cb)` is change-only and listeners run untracked** — the
  bridge listener will only ever fire on real `href` changes, so Solid's
  default `===` signal equality is a harmless double-dedup.
- **Journal facts are `Sequenced<RouterEvent>`** (`{ sequence, event }`), the
  one visible type change for `onEvent` consumers.
- **`stateChanges` is change-only** (requested/failed facts do not emit) —
  though this adapter reads through `subscribe`, not the snapshot stream.
- **Dedup is decide-owned**: navigating to the current href journals nothing
  and never touches history; hooks need no dedup of their own.
- **Public `dispatch` accepts `RouterCommand` only** (type-level); the
  adapter's `useRouterDispatch` inherits that narrowing for free.
- **Dispatch-from-notification is safe by construction.** The chain worth
  reasoning through once: a saga-driven store dispatch notifies the bridge
  listener → `setValue` → Solid runs user effects synchronously → an effect
  calls a hook's navigate → `runtime.runFork(router.dispatch(...))`. Even if
  the forked fiber starts eagerly on the same stack, it merely _suspends_ on
  the router's held saga semaphore (fibers suspend; they do not throw like
  `runSync`) and resumes when the outer saga completes; a store-level
  re-entrant dispatch would enqueue-ack into the command mailbox. No crash,
  no deadlock — only FIFO ordering. This slice pins that with a test instead
  of leaving it as analysis.
- **`ManagedRuntime` exists in `effect@4.0.0-beta.93`** (verified in the
  installed package) — the runtime-ownership design below builds on it.
- **`initial(href)` and `RouterSlice.make(href)`** are exported for seeding
  and fold assertions; the adapter seeds its construction-time state with
  `initial`.

## Setpoint

`@cab/router-solid` is completely rewritten to bridge the router's
`StoreReader` signals directly into Solid signals. `@effect/atom-solid` is
removed from the package and from `shells/playground`.

The consumer-facing API is **frozen plus one additive option**:
`RouterProvider`, `useRouter`, `useRouterState`, `useRouterState({ select })`,
`useRouterNavigate`, `useRouterDispatch`, `createBrowserRouter(options?)`,
`createMemoryRouter(options)`, and the `onEvent` option keep their current
names, signatures, and observable behavior. The one addition is
`useRouterState({ select, equals? })` — custom selector equality, adopted
from TanStack's `compare` option (see Public API below). Omitting `equals`
preserves today's exact behavior. The existing test files are the behavioral
contract.

## Public API

```ts
// ── Construction ─────────────────────────────────────────────
createBrowserRouter(options?: RouterOptions): SolidRouter;
createMemoryRouter(
  options: RouterOptions & { readonly initialHref: string },
): Effect.Effect<MemoryRouter>; // { router: SolidRouter; history: MemoryHistory }

interface RouterOptions {
  // the one visible type change from slice 2: facts arrive sequenced
  readonly onEvent?: (fact: Sequenced<RouterEvent>) => void;
}

// ── Provider & context ───────────────────────────────────────
RouterProvider(props: {
  readonly router: SolidRouter;
  readonly children?: JSX.Element;
}): JSX.Element;
useRouter(): SolidRouter; // advanced escape hatch, unchanged

// ── Reads (the bridge, wearing domain clothes) ───────────────
useRouterState(): Accessor<RouterState>;
useRouterState<TSelected>(options: {
  readonly select: (state: RouterState) => TSelected;
  readonly equals?: (a: TSelected, b: TSelected) => boolean; // additive
}): Accessor<TSelected>;

// ── Writes (fire-and-forget; failures are journal facts) ─────
useRouterNavigate(): (href: string) => void;
useRouterDispatch(): (command: RouterCommand) => void; // RouterCommand only
```

The internal `createKeyAccessor` bridge is deliberately **not** exported.
Rationale for not exposing a generic `useSelector` from this package:
`useRouterState({ select })` already is `useSelector` specialized to the
router's slice, and the generic hook is `@cab/store-solid`'s headline API the
day that package exists — TanStack's own layering (`useAtom` composes
`useSelector`) is the model. `equals` earns its place now because the bridge
puts dedup in the signal's `equals` anyway, and it is the fine-grained lever
for object-returning selectors (a fresh object per selector run re-notifies
every change under `===`; a custom `equals` restores output-level cutoff).

Acceptance criteria:

- All existing `test/router.test.ts` and `test/provider.test.tsx` behavioral
  cases pass after porting to the new internals (journal facts arrive as
  `Sequenced<RouterEvent>` in `onEvent` — the one visible type change).
- `@effect/atom-solid` no longer appears in `libs/router-solid/package.json`
  or `shells/playground/package.json`; the playground renders and navigates
  without a `RegistryProvider`.
- State reads reach Solid through the per-key signal bridge, not through a
  snapshot stream: an unrelated-key change in a future multi-key slice would
  not re-run `useRouterState` consumers (single-key `{ href }` makes this
  latent, but the bridge is written key-fine from day one).
- `useRouterState()` always returns a total accessor: the synchronous
  construction seed until the runtime starts, then the live projection —
  matching today's semantics.
- Provider unmount disposes the runtime, the observation fiber, the `onEvent`
  tap, and all bridge subscriptions; mount/unmount cycles leak nothing
  (asserted by test: after unmount, external history changes produce no
  further subscriber firings).
- Navigation failures stay journal facts, not exceptions: hook-returned
  functions are fire-and-forget `void`, as today.
- **Hook dispatch functions are safe to call from inside Solid effects** that
  react to bridged router state — a `createEffect` observing
  `useRouterState` may call `useRouterNavigate`'s function without defects or
  deadlock; both navigations journal in FIFO order. Pinned by test (this also
  settles the `runFork` eagerness question empirically).

## Design

### Vision note

The earlier "one public atom per adapter instance as the composition point"
decision is superseded by the store foundation: composition across libraries
now happens at the journal/store layer in Effect land, not at the atom layer
in the framework. Atoms exit the stack entirely, dropping the reactivity
systems in a running app from three (atoms + alien-signals + Solid) to two.
The read bridge is the TanStack solid-store pattern, verified in their source:
one Solid `createSignal` per selector hook, fed by the store subscription,
torn down with `onCleanup` — proven at ecosystem scale with no tearing issues
on record.

### `src/router.ts`

`SolidRouter` stays an exported class owning a private impl record (the
capability-object pattern from `router-solid-feature-router-instance.md`),
but the impl changes:

- **Runtime ownership**: each instance owns a `ManagedRuntime` built from its
  router layer (`ManagedRuntime.make(layer, ...)`). This replaces the
  per-instance `Atom.context` / `Layer.makeMemoMapUnsafe()` dance and its
  shared-MemoMap footgun outright — per-instance isolation is now the default
  behavior of owning your own runtime.
- `mountProvider` starts the runtime work: resolves the `Router` service,
  keeps the scoped observation loop alive, and forks the `onEvent` journal
  tap (`reader.journalChanges` consumer) when configured. Unmount runs
  `runtime.dispose()` via `onCleanup`, tearing down the observation fiber and
  tap.
- **Dispatch**: `useRouterNavigate` / `useRouterDispatch` return functions
  that `runtime.runFork(router.dispatch(...))` — fire-and-forget by design;
  failures are `NavigationFailed` journal facts.
- **Construction**: `createBrowserRouter` stays synchronous (seeds
  `RouterState` from `window.location`, falls back to `"/"` outside a
  browser; runtime work starts at provider mount). `createMemoryRouter` stays
  effectful, returning `{ router, history }` with the `MemoryHistory`
  inspection handle for tests.

### `src/bridge.ts` (internal)

The bridge is shaped after TanStack solid-store's `useSelector` — their whole
adapter is one generic primitive, and ours mirrors it so a future
`@cab/store-solid` extraction is mechanical. Their mapping of store utils to
Solid primitives, from `packages/solid-store/src/useSelector.ts`:

```text
TanStack store util                Solid primitive
─────────────────────────────      ───────────────────────────────────────
source.get()  (untracked read)  →  createSignal initial value (sync seed)
source.subscribe(listener)      →  setSignal inside the listener
selector + compare (default ===) → the signal's `equals` option — dedup
                                    lives IN the signal, no memo layer
unsubscribe                     →  onCleanup (owner-tied teardown)
writes (atom.set / setState)    →  passed through raw, never wrapped
context (createStoreContext)    →  pure transport; hooks compose on top
```

Our bridge keeps that exact shape, with one deliberate upgrade — the
subscription is **per key**, so it is strictly finer-grained than TanStack's:
their listener fires on every store change and re-runs the selector each
time; ours only fires when the subscribed key actually changed, because
`reader.subscribe` is change-only at the store.

```text
createKeyAccessor(reader?, key, selector = identity, seed, options?):
  const equals = options?.equals ?? (===)
  const initial = reader ? selector(untracked reader.read(key)) : selector(seed)
  const [value, setValue] = createSignal(initial, { equals })
  // once the runtime has resolved the reader:
  const unsubscribe = reader.subscribe(key, (next) => setValue(() => selector(next)))
  onCleanup(unsubscribe)
  return value
```

- The selector runs **inside the subscription listener**, and dedup is the
  signal's `equals` (TanStack's pattern) — no `createMemo` layer.
- `useRouterState()` is `createKeyAccessor(reader, "href", (href) => ({ href }), ...)`:
  a fresh object per real href change (correct — the state changed), stable
  identity between changes (the signal holds it).
- `useRouterState({ select })` is the same accessor with
  `(href) => select({ href })` as the selector; default `===` equality
  preserves today's output-equality dedup for derived slices.
- **Seeding aligns with TanStack's `source.get()`**: when the runtime is
  ready, seed from an untracked `reader.read(key)` (the live value); the
  construction-time `initialState` seed is only for the pre-runtime window,
  before the Router service has resolved. (Today's adapter has the same
  seed-then-live behavior via `AsyncResult`; the test contract pins it.)

### `src/provider.tsx` and `src/hooks.ts`

- `RouterProvider` / `useRouter` context wiring unchanged in shape.
- Hooks delegate to `SolidRouter` static helpers as today; only the internals
  behind those helpers change.

### `shells/playground`

- Remove `RegistryProvider` from `src/app.tsx` and `@effect/atom-solid` from
  `package.json`. No other changes — that near-zero diff is the proof the
  adapter boundary was right.

## Non-Goals

- No hook renames, no new hooks, no route matching/links/SSR — behavioral
  parity only.
- No generic `@cab/store-solid` package yet. The bridge lives inside
  `router-solid`; extract it once a second Solid store consumer exists (the
  same discipline that deferred `@cab/state`). When that day comes, the
  extraction targets TanStack solid-store's public shape — a generic
  `useSelector(reader, key, selector?, { equals })` plus a
  `createStoreContext`-style pure-transport provider — which is why the
  internal bridge already has that signature.
- No public atom handle, registry integration, or `@effect/atom-solid`
  compatibility layer.
- No exposure of the raw `StoreReader` to components beyond what the hooks
  provide; `useRouter()` remains the advanced escape hatch.

## Implementation Steps

1. Remove `@effect/atom-solid` from `libs/router-solid/package.json`.
2. Rewrite `src/router.ts`: `ManagedRuntime`-owning `SolidRouter`,
   `mountProvider` lifecycle, `runFork` dispatch, unchanged constructor
   signatures.
3. Add internal `src/bridge.ts` (reader key → Solid accessor with seed and
   `onCleanup` teardown).
4. Rewrite hook internals over the bridge; keep `src/provider.tsx` and
   `src/hooks.ts` public APIs identical.
5. Port `test/router.test.ts` and `test/provider.test.tsx` (behavioral cases
   unchanged; `onEvent` facts become `Sequenced<RouterEvent>`); add
   mount/unmount leak coverage (dispose, then drive `history.observe`, assert
   no further firings and no state updates); add the effect-initiated dispatch
   case: a Solid `createEffect` observing router state calls navigate when a
   condition matches (guarded to fire once) — assert both navigations journal
   in FIFO order with no defects; add `equals` coverage: an object-returning
   selector with a custom `equals` does not re-notify consumers when the
   selected output is equal under it, and re-notifies when it is not.
6. Update `shells/playground`: drop `RegistryProvider` and the
   `@effect/atom-solid` dependency.
7. Run focused sensors, close-out sensors, then the manual playground smoke.

## Stability Rules

- The existing adapter tests are the contract, not a starting point for
  redesign — port them, do not rewrite their assertions.
- The bridge is the only file that knows both `StoreReader` and Solid
  primitives; hooks know Solid only, `SolidRouter` knows Effect only.
- A router instance is not swappable after provider setup (existing rule,
  preserved).
- Dispose paths are load-bearing: every `subscribe` pairs with `onCleanup`,
  and the runtime disposes exactly once at provider unmount.
- Keep the playground diff to the registry removal; resist demo expansion.

## PID Sensors

Focused sensors during the loop:

- `pnpm --filter=@cab/router-solid run tsc`
- `pnpm --filter=@cab/router-solid run lint`
- `pnpm --filter=@cab/router-solid run test:unit`
- `pnpm --filter=@cab/shell-playground run tsc`
- `pnpm --filter=@cab/shell-playground run lint`

Close-out sensors:

- `pnpm fmt`
- `pnpm fmt:check`
- `pnpm tsc`
- `pnpm lint`
- `pnpm turbo run test:unit`

Final UI sensor: manual playground smoke — navigate via links and dispatch,
drive browser back/forward, verify `onEvent` console output shows
requested/committed/observed facts. Load `pid-ui-sensors` when executing this
slice if visual verification is needed.
