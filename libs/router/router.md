# @cab/lib-router — Design & Implementation Plan

Event-sourced SPA router built on Effect. This document is the handoff source
of truth: setpoint, research findings, architecture, public contract, and the
step-by-step implementation plan with review gates.

## Setpoint

1. **MUST use event sourcing.** Every navigation request and system outcome is
   an event appended to an in-memory journal. Router state is only ever
   produced by folding the journal. Persistence is out of scope for now.
2. **MUST use Effect** — and idiomatic Effect throughout: `Context.Service`
   for services, `Data.TaggedError` for typed failures, `Data.taggedEnum` for
   events, `Layer` for wiring, `Ref`/`SubscriptionRef`/`Stream` for state,
   `Atom` for UI consumption.
3. **MUST ONLY support navigating the application to a different route.**
   No route matching, params, loaders, guards, blockers, back/forward
   (`popstate`), links, or scroll handling.

Core invariant (holds at all times, tested):

```
fold(initial, journal) === currentState
```

## Critical Environment Facts (read before writing any code)

- This repo uses **effect `4.0.0-beta.93`** (effect-smol). The API differs
  from Effect 3. **Do not use Effect 3 idioms from memory** — verify every
  signature against the installed types in `node_modules/effect/dist/`.
- The Atom library is **inside effect core** at
  `effect/unstable/reactivity/Atom` (there is no separate `effect-atom`
  package). `@effect/atom-solid` is only the Solid bindings and belongs in
  shells, not in this lib.
- Verified idioms in this beta (all checked against installed `.d.ts`):
  - Services: `class Router extends Context.Service<Router, Shape>()("@cab/lib-router/Router") {}`
  - Errors: `class HistoryError extends Data.TaggedError("HistoryError")<{ ... }> {}`
  - Events: `Data.taggedEnum<RouterEvent>()` (gives constructors + `$match`)
  - Functions: `Effect.gen`, `Effect.fn` (traced) exist
  - Layers: `Layer.effect`, `Layer.succeed`, `Layer.mergeAll`, `Layer.provide`
  - State: `Ref`, `SubscriptionRef.make/get/changes` (`changes` returns `Stream`)
  - Atoms: `Atom.runtime` (RuntimeFactory), `Atom.fn`, `Atom.make`, `Atom.family`
- This lib needs **zero new dependencies** — `effect` is already in
  `package.json` via the workspace catalog.

## Research Summary

Studied TanStack Router (`@tanstack/history` + `router-core` + adapters) and
`@solidjs/router` (v0.16), navigation/history layers only.

### Headline finding

**Neither router is event-sourced.** Both are last-write-wins reactive state
synced to the URL. TanStack fires ephemeral typed actions
(`PUSH|REPLACE|BACK|FORWARD|GO`) to subscribers and retains nothing;
solid-router's closest thing to a log is a per-transition redirect stack
cleared on commit. Notably, TanStack stamps `__TSR_key`/`__TSR_index` into
`history.state` just to _re-derive_ discarded event information on popstate.
A journal makes that class of problem disappear — our design is a deliberate
departure here, not a reinvention.

### TanStack Router — what we copy

- **Three-layer split, strict one-way deps**: zero-dependency history package
  (string locations, `subscribe(location, action)`) → framework-free core →
  thin framework adapters. Validates our `History` service seam.
- **Single funnel**: programmatic navigate and browser popstate converge at
  `history.notify()` → one subscriber. Never two code paths for "we
  navigated" vs "the browser navigated". Event-sourcing translation: **the
  journal is the funnel** — future popstate support appends an event through
  the same append → fold → project pipeline.
- **Reactivity is injected, not owned** (`StoreConfig` with store factories
  per framework). We get this for free: `Atom` is framework-agnostic effect
  core; `@effect/atom-solid` (and future react bindings) are the adapters.
- **Dedupe before mutating**: same href + same state never touches history.

### @solidjs/router — what we copy

- **Minimalism benchmark**: the entire medium abstraction is
  `{ get, set, init(notify) }`; browser/hash/memory adapters are ~50 lines
  each. Our `History` shape follows the same spirit.
- **Location is a string** (`pathname+search+hash`); the structured
  `Location` is _derived_ lazily in fine-grained memos. We store `href:
string` in events and derive parsed shapes later as derived atoms.
- Their `key` per-entry identity is hardcoded `""` — shipped without it.

### Convergent behaviors (table stakes, both routers)

- Same-location navigation is a silent no-op (dedupe on `(href, state)`).
- Concurrent navigation commands are serialized inside the `Router` service. v0
  does not drop or supersede earlier navigation requests.
- popstate can only be undone (`history.go(-delta)`), never prevented.
- solid-router commits the URL _after_ the transition settles. Irrelevant
  while our navigation is atomic/synchronous; revisit when async (loaders,
  guards) enters the pipeline.

### Explicitly rejected for v0

- `__TSR_key`/index stamping in `history.state` — the journal already orders
  everything.
- Microtask-batching of `pushState` calls (browsers throttle rapid pushes) —
  real, but irrelevant until navigations fire in bursts.
- Blockers, `beforeLeave`, transitions/`isRouting`, scroll — out of scope by
  setpoint.

## Architecture

Command → events → fold. Package layout mirrors TanStack's layering inside one
package (split later only if needed):

```
libs/router/src/
  event.ts     RouterCommand + RouterEvent tagged enums
  state.ts     RouterState + initial() + reduce()      ← pure, no Effect imports
  history.ts   History service: push(href) + current
               layerWindow (real pushState) / MemoryHistory.make (tests)
  router.ts    Router service + layer: serialized dispatch + Ref<journal>
               + SubscriptionRef<state>
  atoms.ts     Atom bindings: runtime atom, state atom, navigate fn atom
  index.ts     public exports
  test/        vitest unit tests, matching Effect's package-level test layout
```

Framework adapter story (nothing to build now):

```
@tanstack/history       ≈  History service (layerWindow / layerMemory)
@tanstack/router-core   ≈  @cab/lib-router (only dep: effect)
@tanstack/react-router  ≈  @effect/atom-solid consuming our atoms (exists)
```

## Public Contract

Implement against this exactly. Do not rename, widen, or add public API.

```ts
// event.ts — Data.taggedEnum
export type RouterCommand = Data.TaggedEnum<{
  NavigationRequested: {
    readonly href: string     // pathname+search+hash, string-first like both routers
  }
}>
export const RouterCommand: /* Data.taggedEnum<RouterCommand>() constructors + $match */

export type RouterEvent = Data.TaggedEnum<{
  NavigationRequested: {
    readonly sequence: number // monotonic, journal-assigned, starts at 0
    readonly href: string
  }
  NavigationCommitted: {
    readonly sequence: number // monotonic, journal-assigned
    readonly href: string
  }
  NavigationFailed: {
    readonly sequence: number // monotonic, journal-assigned
    readonly href: string
    readonly reason: "window-unavailable" | "push-failed"
    readonly cause?: unknown
  }
}>
export const RouterEvent: /* Data.taggedEnum<RouterEvent>() constructors + $match */

// state.ts — pure, no Effect imports
export interface RouterState {
  readonly href: string
}
export const initial: (href: string) => RouterState
export const reduce: (state: RouterState, event: RouterEvent) => RouterState

// history.ts
export class HistoryError extends Data.TaggedError("HistoryError")<{
  readonly reason: "window-unavailable" | "push-failed"
  readonly cause?: unknown
}> {}

export interface HistoryShape {
  readonly push: (href: string) => Effect.Effect<void, HistoryError>
  readonly current: Effect.Effect<string, HistoryError>
}
export class History extends Context.Service<History, HistoryShape>()(
  "@cab/lib-router/History"
) {}
export const layerWindow: Layer.Layer<History>

export interface MemoryHistoryShape {
  readonly layer: Layer.Layer<History>
  readonly pushes: Effect.Effect<ReadonlyArray<string>>
  readonly current: Effect.Effect<string>
}
export class MemoryHistory extends Context.Service<
  MemoryHistory,
  { readonly make: (initialHref: string) => Effect.Effect<MemoryHistoryShape> }
>()("@cab/lib-router/MemoryHistory") {}
export const MemoryHistoryLive: Layer.Layer<MemoryHistory>

// router.ts
export interface RouterShape {
  // dispatch accepts user-originated commands only; outcome events are system-written.
  readonly dispatch: (command: RouterCommand) => Effect.Effect<void>
  readonly navigate: (href: string) => Effect.Effect<void>       // convenience wrapper over dispatch
  readonly state: Effect.Effect<RouterState>                   // current projection
  readonly changes: Stream.Stream<RouterState>                 // projection updates
  readonly events: Effect.Effect<ReadonlyArray<RouterEvent>>   // journal read
}
export class Router extends Context.Service<Router, RouterShape>()(
  "@cab/lib-router/Router"
) {}
export const layer: Layer.Layer<Router, HistoryError, History>
export const layerBrowser: Layer.Layer<Router, HistoryError>   // layer + layerWindow

// atoms.ts
// The Atom suffix is intentional public API: these exports are UI-reactivity
// primitives, not plain service values or functions.
export const routerRuntimeAtom  // Atom.runtime(layerBrowser); exact type verified in step 4
export const routerStateAtom    // derived Atom for RouterState; exact type verified in step 4
export const routerNavigateAtom // Atom.fn accepting href string; runs Router.navigate

// index.ts — re-exports all of the above
```

Atom exports MUST keep the `router*Atom` naming convention. Do not export
ambiguous UI-facing names like `routerState`, `routerNavigate`, or `navigate`;
those names read like plain values/functions and are too easy to confuse with
the Effect service API. Step 4 MUST replace the comments above with explicit
type annotations verified against
`node_modules/effect/dist/unstable/reactivity/Atom.d.ts`; do not leave the Atom
exports as untyped public constants.

## Using the Public API

Service-level Effect usage:

```ts
import { Effect } from "effect";
import { Router, layerBrowser } from "@cab/lib-router";

const program = Effect.gen(function* () {
  const router = yield* Router;
  yield* router.navigate("/settings");
  return yield* router.state;
});

const state = await Effect.runPromise(Effect.provide(program, layerBrowser));
```

UI adapter usage imports the Atom-facing names and consumes them through the
framework binding, for example `@effect/atom-solid` in Solid shells:

```ts
import { routerNavigateAtom, routerRuntimeAtom, routerStateAtom } from "@cab/lib-router";
```

## Semantics (these become the tests)

1. `dispatch(RouterCommand.NavigationRequested({ href: "/a" }))` appends a
   `NavigationRequested` event with the next monotonic sequence. `navigate("/a")`
   is a convenience wrapper over this command.
2. If `History.push("/a")` succeeds, the router appends a
   `NavigationCommitted` event with the next monotonic sequence and updates the
   projection to `{ href: "/a" }`.
3. If `History.push("/a")` fails, the router appends a `NavigationFailed` event
   with the next monotonic sequence, `reason`, and optional `cause`; projection
   state is unchanged. No rollback is needed because the journal records the
   request and its failed outcome as facts.
4. `navigate` or `dispatch` to the current href appends **nothing** — journal
   length and state unchanged, no history push (silent no-op; validated by both
   TanStack and solid-router).
5. Replay invariant: after any number of navigations, folding `events`
   through `reduce` from `initial` equals `state` exactly.
6. `reduce` only changes `RouterState` for `NavigationCommitted`; requested and
   failed events leave state unchanged.
7. Each non-deduped navigation command triggers exactly one `History.push`
   attempt — with `MemoryHistory.make`, recorded pushes correspond one-to-one
   with `NavigationCommitted` plus `NavigationFailed` outcome events.
8. `layer` seeds initial state from `History.current` at construction.
9. `changes` emits the seeded state then one update per committed navigation
   that changes the projection.
10. `layerWindow` fails with `HistoryError{ reason: "window-unavailable" }`
    when `window` is not available during layer construction; push failures are
    captured as `NavigationFailed` events with
    `HistoryError{ reason: "push-failed", cause }` data.
11. Concurrent `dispatch`/`navigate` calls are processed one at a time. A
    command's dedupe check, request event, history push attempt, outcome event,
    and projection update complete before the next command starts.

## Implementation Steps (review gate after every step)

Stop after each step for human review. Do not start the next step until the
current one is approved.

**Step 1 — Domain core.** `event.ts` + `state.ts` + `test/state.test.ts`.
Pure code only: command tagged enum, event tagged enum, initial, reduce, fold
tests. No Effect imports in `state.ts`. Sensors: focused lint/tsc/test:unit
for the package.

**Step 2 — History service.** `history.ts` + `test/history.test.ts`.
`HistoryError`, `History` service, `layerWindow`, `MemoryHistory` service, and
`MemoryHistoryLive`. `MemoryHistory.make(initialHref)` returns a layer plus
inspection effects for `pushes` and `current`. Tests run against
`MemoryHistory.make` and assert memory behavior; no DOM, no mocks of internals.
Sensors: focused lint/tsc/test:unit.

**Step 3 — Router service.** `router.ts` + `test/router.test.ts`.
Journal `Ref<ReadonlyArray<RouterEvent>>`, projection
`SubscriptionRef<RouterState>` seeded from `History.current`. `dispatch` is
serialized with the smallest Effect synchronization primitive verified against
the installed v4 typings: dedupe same-href `NavigationRequested` commands →
append `NavigationRequested` (next sequence) → run exactly one `History.push`
attempt → append `NavigationCommitted` on success or `NavigationFailed` on
failure → fold into projection. `navigate` delegates to `dispatch`. Tests cover
semantics 1–11 (replay invariant is the centerpiece). Sensors: focused
lint/tsc/test:unit.

**Step 4 — Atom bindings + public surface.** `atoms.ts` + `index.ts`.
`Atom.runtime(layerBrowser)`, state atom from `changes`/`state`, navigate
via `Atom.fn` exported as `routerNavigateAtom`. Verify `Atom.runtime`,
derived-atom, and `Atom.fn` signatures in
`node_modules/effect/dist/unstable/reactivity/Atom.d.ts` before writing.
Add explicit public type annotations for `routerRuntimeAtom`, `routerStateAtom`,
and `routerNavigateAtom`. Sensors: focused lint/tsc (atoms are exercised for
real in step 5).

**Step 5 — Full verification + audit.** Repo-wide `pnpm fmt`, `pnpm check`,
`pnpm test:unit`. Audit the whole diff for residue (duplicate logic, dead
exports, debug leftovers). Optional demo: wire a two-route toy into
`shells/playground` using `@effect/atom-solid` hooks to prove the adapter
story end to end.

Commit convention per step: `feat(lib-router): <description>` (scope is the
package name without the npm scope; see `CONTRIBUTING.md`).

## Sensors

Focused (during a step):

```bash
pnpm --filter=@cab/lib-router run lint
pnpm --filter=@cab/lib-router run tsc
pnpm --filter=@cab/lib-router run test:unit
```

Repo-wide (before completing a step / committing):

```bash
pnpm fmt && pnpm check && pnpm test:unit
```

If a sensor fails: read the exact failure, patch only against that error
signal, re-run. No broad rewrites as a first corrective action.

## Extension Seams (designed for, deliberately not built)

- **`RouterEvent` union** grows: replace request/commit/fail events, external
  location changes (`popstate` → `ExternalLocationChanged` appended through the
  same journal — the single-funnel translation), redirects.
- **`HistoryShape`** and `MemoryHistoryShape` grow together: `replace`,
  `subscribe`/change stream for external changes, `go/back/forward`.
- **Derived location parsing**: `pathname`/`search`/`hash` as derived atoms
  parsing `state.href` (solid-router's derived-memo approach) — nothing
  stored, nothing to keep consistent.
- **Persistence**: swap the journal `Ref` behind a service interface when
  events need to outlive the session; consider `Schema` for events at that
  point (deliberately plain `Data.taggedEnum` until then).
- **Async navigation** (guards/loaders): revisit atomic append+push —
  solid-router commits the URL only after its transition settles.

## Constraints Recap (for any implementing agent)

- No new dependencies. No `any`. Kebab-case filenames. Fence comments
  (`// -- Types --` style) per `CONTRIBUTING.md` for larger files.
- Load and apply the `pid` skill before editing (repo rule).
- Tests assert behavior through the public contract only — never reach into
  journal internals beyond the public `events` read.
- Smallest change that satisfies the step; no scope creep into extension
  seams.
