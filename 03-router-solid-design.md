# Router Solid Design: Rewrite `@cab/router-solid` On The Store Bridge

Slice 3 of the store foundation series. Prerequisites: `@cab/store`
(shipped, see `libs/store/README.md`) and `02-router-design.md`
implemented and green. This slice also carries the small `shells/playground`
update, since the adapter rewrite removes the registry requirement.

## Setpoint

`@cab/router-solid` is completely rewritten to bridge the router's
`StoreReader` signals directly into Solid signals. `@effect/atom-solid` is
removed from the package and from `shells/playground`.

The consumer-facing API is **frozen**: `RouterProvider`, `useRouter`,
`useRouterState`, `useRouterState({ select })`, `useRouterNavigate`,
`useRouterDispatch`, `createBrowserRouter(options?)`,
`createMemoryRouter(options)`, and the `onEvent` option keep their current
names, signatures, and observable behavior. The existing test files are the
behavioral contract.

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

The reader→Solid bridge, kept small and private:

```text
routerAccessor(reader, key, seed):
  const [value, setValue] = createSignal(seed, { equals: false? no — default })
  // seed until runtime ready; once mounted:
  const unsubscribe = reader.subscribe(key, (next) => setValue(() => next))
  onCleanup(unsubscribe)
  return value
```

- One Solid signal per hook call, seeded from the construction-time
  `initialState` (total accessor semantics), updated by `reader.subscribe`.
- Solid's default `===` equality is correct here because the store already
  guarantees change-only notifications; double-dedup is harmless.
- `useRouterState({ select })` wraps the key accessor in
  `createMemo(() => select(...))`, preserving today's output-equality dedup
  for derived slices.
- The bridge must handle the pre-runtime window: before the runtime resolves
  the Router service, the accessor serves the seed; once available, it
  switches to live subscription. (Today's adapter has the same seed-then-live
  behavior via `AsyncResult`; the test contract pins it.)

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
  same discipline that deferred `@cab/state`).
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
   no further firings and no state updates).
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
