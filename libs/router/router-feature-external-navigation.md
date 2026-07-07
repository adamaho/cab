# Router Feature: External Navigation

## Setpoint

When the browser location changes outside `router.navigate` or
`router.dispatch`, the router records a sequenced journal fact and updates
`RouterState.href` to the observed href.

This feature makes browser back/forward navigation visible to the core router.
External navigation is part of the browser routing boundary, so the router must
observe it to keep its projected state consistent with the actual location.

## Acceptance Criteria

- `WindowHistory.layer` observes browser `popstate` events.
- `Router.layerBrowser` updates `router.state` when the browser back/forward
  buttons change the current href.
- External browser navigation appends one sequenced journal event after the
  router has observed the new href.
- `router.stateChanges` emits the updated state for observed external
  navigation.
- `router.journalChanges` emits the observed external navigation event.
- Router-owned `navigate` and `dispatch` calls do not double-record events
  through the external navigation stream.
- Navigating externally to the currently projected href is a silent no-op.
- Processing an observation reads the current location at processing time, so a
  queued observation never folds a stale href into projected state (for
  example, a popstate that raced a router-owned push, or a rapid back/forward
  burst).
- `MemoryHistory.make` can drive the same behavior in tests without a browser,
  and its `current` reflects the latest of router-owned pushes and external
  observations.
- The feature does not add route matching, route params, `<Link>`, outlets,
  route components, or a `router-solid` package.

## Current Error Signal

The router currently reads `History.current` once at layer construction and only
changes state from router-owned commands. `WindowHistory` exposes `push` and
`current`, but no stream for browser-originated location changes. If a user
presses the browser back or forward button, the URL can change while
`RouterState.href` remains stale.

## PID Sensors

Focused sensors for the inner loop:

- `pnpm fmt`
- `pnpm fmt:check`
- `pnpm --filter=@cab/router run tsc`
- `pnpm --filter=@cab/router run lint`
- `pnpm --filter=@cab/router run test:unit`

Repo-wide close-out sensors before completion (`HistoryShape` is a public API
change and `@cab/shell-playground` consumes `@cab/router` from source):

- `pnpm tsc`
- `pnpm lint`
- `pnpm turbo run test:unit`

Manual sensors:

- Manual diff review for public API drift and accidental scope expansion.

## Design

### Event Model

Add one event variant for committed navigation observed from outside the router
command path:

```ts
RouterEvent.NavigationObserved({ sequence, href });
```

Decision: use `NavigationObserved` as the final event variant name.

`NavigationObserved` is a journal fact, not a command. It records that the
environment already changed location and the router observed the committed
result. It should update projected state the same way `NavigationCommitted`
does.

Keep `RouterCommand` unchanged. Commands still represent caller intent;
observed browser navigation is not caller intent.

Optional drift-prevention cleanup while touching `event.ts`:
`NavigationFailed.reason` hardcodes `"window-unavailable" | "push-failed"`
instead of reusing `HistoryErrorReason` from `history.ts`. Swapping in the
shared type is in-scope as a one-line change; skip it if it grows the diff
beyond the swap.

### History Boundary

Extend `HistoryShape` with a stream of externally observed hrefs:

```ts
readonly changes: Stream.Stream<string>
```

The stream has no error channel. Neither adapter can fail while observing
(popstate listening does not throw; the memory helper is a `Ref` update), and an
error channel would let the router's observation fiber die silently — a worse
failure mode than the one it would model. Widen the channel later only if a real
failure source appears.

Semantics:

- `changes` emits hrefs that were observed after the history layer was created.
- `changes` is live-only and does not replay `current`.
- The emitted href is a convenience snapshot taken at observation time. The
  router treats each emission as a "location changed" signal and re-reads
  `current` when processing; consumers must not assume the payload is still the
  current location by the time they act on it.
- `WindowHistory.changes` emits on `popstate` using the current browser href.
  Implement it with `Stream.fromEventListener(window, "popstate")` (available in
  effect v4), which handles listener registration and removal per subscription —
  no hand-rolled `Stream.callback` cleanup.
- `WindowHistory.push` remains a direct `pushState` mutation and must not itself
  publish to `changes`. This matches browser reality: `pushState` does not fire
  `popstate`.
- `MemoryHistory` gets a test-only helper for external navigation so tests can
  exercise the same router behavior without a browser.

The memory helper should not be named `push`, because router-owned pushes and
external observations have different semantics. Prefer a name like
`observe(href)` on the `MemoryHistory` handle.

`MemoryHistory.current` is currently derived from `pushes.at(-1) ?? initialHref`.
That derivation must change: track one unified location `Ref` updated by both
`push` and `observe`, and keep `pushes` as a separate assertion log. Otherwise
`current` reports the last push after an observation, the memory adapter
diverges from the browser adapter, and the router's re-read-current dedupe
(below) silently drops observations in tests.

### Router Layer

At layer construction, fork a scoped fiber that consumes `history.changes` and
serializes each observation through the same semaphore used by `dispatch`. In
effect v4, `Layer.effect` excludes `Scope` from `R`, so `Effect.forkScoped`
works inside the existing layer constructor as-is and ties the consumer fiber to
the layer's lifetime — no switch to a different layer constructor is needed.

Treat each emission as a "location changed" signal, not as a payload to trust.
Observations queue behind the semaphore, so the emitted href can be stale by the
time it is processed. Concretely: with projected state at `/b` and a dispatch to
`/c` holding the semaphore before its `pushState` runs, a back-button press to
`/a` queues an observation of `"/a"`; the dispatch then completes, leaving both
browser and state at `/c`; folding the queued `"/a"` would move state to `/a`
while the browser sits at `/c` — permanent divergence. Re-reading the location
at processing time resolves this.

For each emission, under the semaphore:

- read `history.current` (not the emitted payload)
- read the current router state
- if `state.href === current`, do nothing
- otherwise append `NavigationObserved({ sequence, href: current })`
- update the folded state projection

`HistoryShape.current` is typed with `HistoryError`, so the re-read puts that
error in the fiber's channel. Neither adapter fails at use time (`WindowHistory`
is `Effect.sync`; memory is a `Ref` read), but the fiber must not be able to die
silently on the typed channel: skip the single observation on failure (for
example `Effect.option` on the read) and keep consuming. A later emission
resynchronizes state.

Buffer the consumer with a sliding buffer of 1 (latest-wins). Re-reading
`current` already makes intermediate hrefs from a rapid back/forward burst
collapse into the final location; the sliding buffer makes that coalescing
explicit and avoids queueing work that will dedupe to nothing.

This keeps command handling and external observations in one journal sequence
and prevents interleaving a browser observation in the middle of a router-owned
navigation attempt.

Known accepted gap: a popstate that fires between the layer's initial
`history.current` read and the consumer fiber's subscription start is missed.
The window is a few microtasks wide, and the re-read-current design means any
later emission resynchronizes state. Do not add machinery for it.

### State Reducer

Update `reduce` so `NavigationObserved` changes `href` exactly like
`NavigationCommitted`.

Requested and failed events remain state-neutral.

### Public Documentation

Update `README.md` after implementation to state that browser back/forward is
supported and represented as observed navigation facts.

## Stability Rules

- Keep `libs/router/src/state.ts` pure. Do not import Effect, Stream, Atom, or
  History into the reducer module.
- Do not introduce route definitions, route matching, params, links, outlets, or
  Solid components in this feature.
- Do not move atoms to a new package in this feature.
- Preserve the existing `navigate` and `dispatch` semantics for router-owned
  navigation.
- Keep `journalChanges` live-only and `journal` retained.
- Use `Effect.fn` at service or effectful boundary functions, not for pure
  reducer helpers.
- Public exports must keep Effect-style JSDoc with `@category` and
  `@since 0.0.0`.

## Implementation Steps

1. Add `NavigationObserved` to `RouterEvent` and update state reducer tests.
   Optionally swap `NavigationFailed.reason` to reuse `HistoryErrorReason`.
2. Extend `HistoryShape` with `changes: Stream.Stream<string>` (no error
   channel).
3. Implement `WindowHistory.changes` with
   `Stream.fromEventListener(window, "popstate")`.
4. Add the memory `observe(href)` helper and change stream, and rework
   `MemoryHistory` around a unified location `Ref` (updated by `push` and
   `observe`) with `pushes` kept as a separate assertion log.
5. Teach `Router.layer` to consume `history.changes` via `Effect.forkScoped`
   with a sliding buffer of 1, re-reading `history.current` under the existing
   semaphore before appending `NavigationObserved`.
6. Add router service tests for observed external navigation, dedupe, state
   stream, journal stream, no double-recording for router-owned navigation, and
   the stale-observation race (observation queued behind an in-flight dispatch
   folds the re-read location, not the emitted payload).
7. Update `README.md` scope and behavior guarantees.
8. Run the focused PID sensors during the loop, patch only against measured
   failures, and finish with the repo-wide close-out sensors.

## Todos

- [x] Decide the final event variant name: `NavigationObserved` — it describes a
      committed environmental fact, and popstate also covers hash jumps and
      `history.go()`, not just restores.
- [x] Add event constructor and reducer behavior.
- [x] Add `HistoryShape.changes` (error-free stream) and update all history
      adapters/tests.
- [x] Implement browser `popstate` observation via `Stream.fromEventListener`.
- [x] Add memory `observe(href)` helper and unify `MemoryHistory.current` with
      a single location `Ref`.
- [x] Serialize external observations with command dispatch, re-reading
      `history.current` at processing time.
- [x] Add tests for state, journal, stream behavior, and the stale-observation
      race.
- [x] Update consumer README.
- [x] Run focused router verification, then the repo-wide close-out sensors.

## Deferred Work

- `@cab/router-solid`
- `createBrowserRouter()` and `<RouterProvider router={router}>`
- `<Link>` click interception and active-state helpers
- route definitions, route matching, params, nested routes, and outlets
- persisted journals or cross-session replay
