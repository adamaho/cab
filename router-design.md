# Router Design: Rewrite `@cab/router` On `@cab/store`

Slice 2 of 3. Prerequisite: `@cab/store` is shipped (`libs/store`, 24 passing
tests; `libs/store/README.md` is the public API reference). The follow-up
slice is `router-solid-design.md`, which rewrites the Solid adapter against
the shape defined here.

## Store Facts This Design Relies On

The shipped `@cab/store` semantics that shape this rewrite:

- **Public surface**: `Store.make(definition)`, `Store.defineSlice` /
  `defineSlice`, `SliceDefinition`, `StoreReader`, `Sequenced`. There is no
  options bag on `Store.make` — seeding happens through the definition's
  `initial`, which is why the router slice is a **factory** (see below).
- **`Store.make` needs no `Scope`** and is `runSync`-safe; the store creates
  no long-lived fibers or effects of its own.
- **`dispatch` is `Effect.Effect<void>` with no error channel.** `decide`
  rejection is silent (`[]` → nothing appended, nobody notified), so the saga
  detects acceptance by journal growth, not by catching anything. The only
  defects are programmer errors (non-converging cascades).
- **Dispatch is sync at the boundary with an internal command mailbox.** The
  saga's dispatches are always _boundary_ dispatches (they run on fibers, not
  inside subscriber listeners), so each `store.dispatch` returns with the
  fact journaled and subscribers notified. The mailbox/cascade machinery is
  irrelevant to the router by construction: consumers only ever receive the
  `reader`, so nothing outside the saga can dispatch at all — cascades cannot
  be triggered by router consumers.
- **`stateChanges` emits the current snapshot on subscription** and each
  folded snapshot after it — the seeding contract `@cab/router-solid`'s
  adapter relies on.
- **`subscribe` is change-only and listeners run untracked**; `read`/`select`
  are synchronous and trackable. The router service itself uses none of these
  (it consumes only Effect-land views), but they ride along on the exposed
  `reader` for the adapter slice.

## Setpoint

`@cab/router` is completely rewritten so it stops owning state machinery and
becomes exactly two things:

1. a **slice definition** — router commands, events, `decide`, `reduce` — per
   the Redux-model split documented in `libs/store/README.md`, and
2. a **process manager service** that owns the `History` I/O saga over a
   private `Store` instance.

All journal machinery (`Ref` journal, `PubSub`, sequencing, fold-commit,
`SubscriptionRef` state) is deleted from the router and provided by
`@cab/store`.

Acceptance criteria:

- Existing router behavior is preserved test-for-test: request/commit/fail
  facts for owned navigation, observed facts for external navigation, dedup of
  same-href navigation, seeding from history, gapless monotonic sequences,
  live journal streaming, and `fold(initial, journal)` equals projected state.
- Navigation I/O (`history.push`) lives in the router service; `decide` stays
  pure and never sees an `Effect`.
- Router consumers cannot append navigation facts without the saga: the public
  surface exposes `dispatch`/`navigate` plus a read-only `StoreReader` — never
  the writable store.
- Router events no longer carry a hand-rolled `sequence` field; the store's
  `Sequenced` wrapper owns sequencing. The journal element type becomes
  `Sequenced<RouterEvent>`.
- `history.ts` (`History`, `WindowHistory`, `MemoryHistory`, error types) is
  untouched and its tests pass unmodified.

What MUST NOT change in this slice: `@cab/store` internals (if this rewrite
reveals a store gap, patch the store first as its own loop with its own
tests), `@cab/router-solid` (rewritten in the next slice — it will be broken
against the new router shape until then, which is acceptable only if the
slices land as one PR train; otherwise land this slice and the adapter slice
together).

## Design

### `src/slice.ts` (replaces `event.ts` + `state.ts`)

- `RouterState` stays `{ readonly href: string }`.
- `RouterCommand` keeps `NavigationRequested` and gains the saga-internal
  cases the process manager dispatches into the store:
  `NavigationCommitted`, `NavigationObserved`, `NavigationFailed`. Commands
  express "something should be recorded"; `decide` decides whether it becomes
  a fact.
- `RouterEvent` keeps its four cases but **loses the `sequence` field**.
- `decide` absorbs the dedup currently done inline in `router.ts`:
  - `NavigationRequested`: `state.href === href → []`, else emit requested.
  - `NavigationObserved`: `state.href === href → []`, else emit observed.
  - `NavigationCommitted` / `NavigationFailed`: emit unconditionally (the
    saga only dispatches them after a real history outcome).
- `reduce` is the current fold, unchanged in spirit: requested/failed leave
  state alone; committed/observed set `href`.
- **The slice export is a factory, not a constant.** `Store.make(definition)`
  seeds from `definition.initial` (there is no seed override on `make`), and
  the router only learns its starting href from `history.current` at layer
  construction. So `src/slice.ts` defines `decide` and `reduce` once at
  module scope and exports:

  ```ts
  export function routerSlice(
    href: string,
  ): SliceDefinition<RouterState, RouterCommand, RouterEvent>;
  ```

  which returns `defineSlice({ name: "router", initial: initial(href), decide, reduce })`.
  Keep exporting the `initial(href)` helper too — the adapter slice seeds its
  Solid-side initial state with it, and tests fold against it.

### `src/router.ts`

The `Router` service keeps its `Context.Service` tag and `layer` /
`layerBrowser` statics, holds the writable `Store` privately, and exposes:

```ts
export interface RouterShape {
  /** Dispatches a user-originated router command through the navigation saga. */
  readonly dispatch: (command: RouterCommand) => Effect.Effect<void>;

  /** Navigates to an href by dispatching a navigation request command. */
  readonly navigate: (href: string) => Effect.Effect<void>;

  /** Read-only store surface: state, stateChanges, read, select, subscribe, journal, journalChanges. */
  readonly reader: StoreReader<RouterState, RouterEvent>;
}
```

This is a deliberate, honest break from the old shape: reads move from
`router.state` / `router.journal` to `router.reader.state` /
`router.reader.journal`. The old members are **not aliased** — writes live on
the service, reads live on the reader.

The saga, serialized by the router's own `Semaphore(1)` (the store's internal
serialization guards appends; the router's semaphore guards the
request→outcome pair):

```text
dispatch(NavigationRequested{href}):
  withPermit:
    before = (yield* store.journal).length
    yield* store.dispatch(NavigationRequested{href})   // decide dedups; returns
                                                        // with the fact journaled
                                                        // and subscribers notified
    after = (yield* store.journal).length
    if after === before -> return                       // decide rejected: no-op
    history.push(href) match:
      success -> store.dispatch(NavigationCommitted{href})
      failure -> store.dispatch(NavigationFailed{href, reason, cause?})
```

The journal-growth check is the acceptance signal because `dispatch` has no
error channel and requested events do not change `RouterState` — journal
length is the only observable difference between "accepted" and "deduped".

The history observation loop (unchanged sliding-buffer stream, forked scoped)
dispatches `NavigationObserved` through the same semaphore; `decide` drops
echoes of router-owned navigation because the committed fold already updated
`href`.

Construction, resolved against the shipped `Store.make(definition)` API:

```text
layer = Layer.effect(Router, Effect.gen:
  history  = yield* History
  href     = yield* history.current
  store    = yield* Store.make(routerSlice(href))   // factory seeds initial
  ...saga + observation loop...
  return { dispatch, navigate, reader: store.reader })
```

### `src/index.ts`

Exports: `Router`, `RouterShape`, `RouterCommand`, `RouterEvent`,
`RouterState`, the `routerSlice(href)` factory, `initial`, and the untouched
history surface. `Sequenced` and `StoreReader` are not re-exported —
consumers import them from `@cab/store` (mirroring how `index.ts` in
`libs/store` exports explicit names only).

## Non-Goals

- No route matching, params, links, outlets, loaders, guards, blockers,
  scroll restoration, or SSR. The rewrite preserves current router scope,
  nothing more.
- No store API additions beyond the shipped `@cab/store` public surface
  (`libs/store/README.md`), unless done as a store-first patch loop with its
  own tests.
- No changes to `history.ts`.
- No back-compat aliases for the old `RouterShape` members.

## Implementation Steps

1. Add `@cab/store` as a `workspace:*` dependency of `@cab/router`.
2. Write `src/slice.ts`: commands, events (no `sequence`), `decide`, `reduce`,
   the `routerSlice(href)` factory, `initial`. Port JSDoc per CONTRIBUTING.
3. Delete `src/event.ts` and `src/state.ts`.
4. Rewrite `src/router.ts`: build the seeded store, implement the saga and
   observation loop, expose `{ dispatch, navigate, reader }`. Keep
   `layer` and `layerBrowser`.
5. Update `src/index.ts` exports.
6. Tests:
   - `test/slice.test.ts` (replaces `state.test.ts`): `decide` dedup and
     transition rules per command; `reduce` fold cases; fold invariant helper;
     `routerSlice(href)` seeds `initial` correctly.
   - `test/router.test.ts`: port every existing behavioral case to the new
     shape (reads via `reader`, journal entries as `Sequenced<RouterEvent>`
     with store-assigned gapless sequences), including the `forkCollect`
     live-stream cases; add a case asserting the reader exposes no
     `dispatch`; add a case asserting a deduped request (same href) appends
     nothing and never calls `history.push` (the journal-growth acceptance
     check).
   - `test/history.test.ts`: must pass unmodified.
7. Run focused sensors, then close-out sensors. Expect `@cab/router-solid`
   to fail repo-wide `tsc` until the adapter slice lands — see the note in
   the setpoint about landing slices 2 and 3 as one train if that breakage
   cannot be tolerated on the branch.

## Stability Rules

- The router never touches a signal directly — it consumes `Store` /
  `StoreReader` only. If the router wants a signal, that is a store API
  conversation, not an import.
- `decide` stays pure; any new navigation behavior that needs I/O goes in the
  service saga.
- Do not widen the rewrite into new router features; behavioral parity with
  the current test suite is the whole setpoint.
- Preserve `MemoryHistory`'s inspection surface (`pushes`, `observe`) —
  the adapter slice and its tests depend on it.

## PID Sensors

Focused sensors during the loop:

- `pnpm --filter=@cab/router run tsc`
- `pnpm --filter=@cab/router run lint`
- `pnpm --filter=@cab/router run test:unit`

Close-out sensors (noting the expected `router-solid` breakage window):

- `pnpm fmt`
- `pnpm fmt:check`
- `pnpm tsc`
- `pnpm lint`
- `pnpm turbo run test:unit`

The behavioral contract sensor is the ported `test/router.test.ts`: every
case that exists today must exist and pass after the rewrite, with only
shape-level (not behavior-level) edits.
