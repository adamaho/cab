# Journal Metadata Design: Attributed, Timestamped, Serializable Facts

Slice 4 of the store foundation series. Prerequisites: `@cab/store` shipped
(slice 1), `@cab/router` rewritten on the store (slice 2,
`02-router-design.md`), `@cab/router-solid` rewritten on the reader bridge
(slice 3, `03-router-solid-design.md`). This slice is cross-cutting by nature:
it touches the store's journal shape and ripples through the router and the
adapter's dispatch path.

## Why This Exists (Mission Alignment)

The cab mission is multiplayer interfaces between humans and agents: intent
as commands, state as understandable history. The shipped journal knows
**what** happened but not **who** did it or **when**:

- A `NavigationRequested` from a human click and one from an agent command
  are byte-identical. An agent cannot ask "did the human just navigate while
  I was working, or is this my own action?" and a human cannot audit which
  actor drove the session.
- Facts carry a sequence but no wall-clock time. "Understandable history"
  for a human reading a session — or an agent reasoning about staleness —
  wants _when_, not just order.
- `NavigationFailed.cause?: unknown` can hold a live `Error`. The journal is
  the future wire format for remote agents; every fact must be plain
  serializable data.

**Deliberately out of scope — correlation/causation IDs.** Agents dispatch
commands and monitor outcomes by reading the journal; that inference loop is
the intended design, not a gap. Facts follow their command synchronously and
in order, and actor attribution (this slice) removes the remaining ambiguity
about whose facts they are. Revisit only if concrete usage with multiple
concurrent agents shows the inference genuinely breaking down.

**Deferred to its own slice — reversibility commands.** `Back`/`Forward` as
user-originated `RouterCommand` cases are a mission item, but they require
growing the `History` service surface (`back`, `forward` on `WindowHistory`
and `MemoryHistory`), which is a router-domain feature slice, not a journal
fact-shape change. Do not fold it into this one.

## Setpoint

Every journal fact answers who and when, and every fact is plain data.

Target shape:

```ts
const journal = Effect.runSync(router.reader.journal);
// [
//   {
//     sequence: 0,
//     at: 1751980800000,                       // epoch ms, store-stamped
//     actor: { _tag: "Human" },                // who dispatched the command
//     event: { _tag: "NavigationRequested", href: "/settings" },
//   },
//   {
//     sequence: 1,
//     at: 1751980800004,
//     actor: { _tag: "Human" },                // outcomes inherit the
//     event: { _tag: "NavigationCommitted", href: "/settings" },  // request's actor
//   },
//   {
//     sequence: 2,
//     at: 1751980812345,
//     actor: { _tag: "System" },               // externally observed change
//     event: { _tag: "NavigationObserved", href: "/billing" },
//   },
// ]
```

Acceptance criteria:

- `Sequenced<TEvent>` becomes
  `{ sequence: number; at: number; actor: Actor; event: TEvent }`. The store
  stamps `sequence` and `at`; the dispatcher supplies `actor`.
- `Actor` is a store-owned tagged enum: `Human`, `Agent` (with an optional
  `id` for distinguishing multiple agents), and `System` (runtime-observed
  or infrastructure-originated facts). Store `dispatch` defaults to
  `Actor.System()` when no actor is given.
- `store.dispatch(command, options?)` accepts
  `{ readonly actor?: Actor }`. All existing dispatch semantics are
  unchanged: sync boundary, mailbox, depth guard, `runSync` safety. Inner
  (listener-enqueued) dispatches carry their own actor option or default.
- Timestamps come from Effect's `Clock`, not `Date.now()`, so tests are
  deterministic under `@effect/vitest`'s test clock and the command path
  stays `runSync`-safe.
- The router saga threads actors: `RouterShape.dispatch`/`navigate` accept
  an optional actor, the requested fact carries it, and the outcome fact
  (committed/failed) **inherits the actor of the request that caused it**.
  `NavigationObserved` facts are stamped `Actor.System()`.
- `@cab/router-solid` hooks stamp `Actor.Human()` by default:
  `useRouterNavigate`/`useRouterDispatch` dispatch as `Human` unless the
  caller overrides — UI interactions are human actions unless stated
  otherwise. `onEvent` receives the enriched `Sequenced` facts unchanged.
- `NavigationFailed` becomes fully serializable: the `cause?: unknown` field
  is replaced by `message?: string` (derived from the cause at the saga
  boundary). The raw cause is not journaled; if deep diagnostics are needed
  they belong in tracing/log output, not in facts.
- The fold invariant, fine-grained notification guarantees, and every
  existing behavioral test keep passing (with journal assertions updated for
  the new fact shape).

## Design

### `@cab/store`

- `src/event.ts` gains `Actor`:

  ```ts
  export type Actor = Data.TaggedEnum<{
    Human: {};
    Agent: { readonly id?: string };
    System: {};
  }>;
  export const Actor = Data.taggedEnum<Actor>();
  ```

  and `Sequenced<TEvent>` grows to
  `{ readonly sequence: number; readonly at: number; readonly actor: Actor; readonly event: TEvent }`.
  This is additive for readers (existing field access keeps working); exact
  journal equality assertions in tests are updated in this slice.

- `src/store.ts`:
  - `dispatch: (command: TCommand, options?: DispatchOptions) => Effect.Effect<void>`
    with `DispatchOptions = { readonly actor?: Actor }`, default
    `Actor.System()`.
  - The mailbox enqueues `{ command, actor }` pairs so inner dispatches keep
    their own attribution through the drain.
  - `append` stamps `at` via `Clock.currentTimeMillis` (sync, `runSync`-safe)
    alongside the existing sequence assignment.
  - Considered and rejected for now: carrying the actor via FiberRef/context
    instead of an options parameter. Context propagation is elegant in pure
    Effect-land but invisible at the adapter boundary where most dispatches
    originate; an explicit parameter keeps attribution auditable at the call
    site. Revisit if actor-threading through sagas becomes noisy.

### `@cab/router`

- `src/slice.ts`: `NavigationFailed` event drops `cause?: unknown` for
  `message?: string`. `HistoryErrorReason` stays. Everything else unchanged.
- `src/router.ts`:
  - `RouterShape.dispatch(command, options?)` and
    `navigate(href, options?)` accept `{ readonly actor?: Actor }` and
    forward it to the store dispatch of the requested command.
  - The saga captures the request's actor and reuses it for the outcome
    dispatch (committed/failed) — attribution follows causation without
    needing causation IDs.
  - The observation loop dispatches observed commands with
    `Actor.System()`.
  - The `history.push` failure handler derives `message` from the error
    (`String(error.cause ?? error.reason)` or similar) instead of journaling
    the raw cause.

### `@cab/router-solid`

- Hook-returned functions dispatch with `Actor.Human()` by default; both
  hooks accept an optional actor override for embedded-agent use cases.
- No other adapter changes: the bridge and provider are attribution-agnostic.

## Non-Goals

- No correlation or causation IDs on facts (deliberate; see Mission
  Alignment above).
- No `Back`/`Forward` reversibility commands (own slice; requires `History`
  surface growth).
- No schema validation or runtime enforcement of event serializability —
  the constraint is documented and upheld by review; enforce with `Schema`
  only when facts actually cross a wire.
- No persistence, transport, or remote-agent bridge. This slice makes facts
  _ready_ for the wire; it does not build one.
- No actor-based authorization. Attribution is observability, not access
  control; the reader/dispatch split remains the only write guard.

## Implementation Steps

1. `@cab/store`: add `Actor`, extend `Sequenced`, add `DispatchOptions`,
   thread `{ command, actor }` through the mailbox, stamp `at` from `Clock`.
   Update JSDoc (`@category`/`@since` per CONTRIBUTING).
2. `@cab/store` tests: update journal equality assertions for the new
   shape; add cases —
   - facts default to `Actor.System()` and carry a `Clock`-derived `at`
     (deterministic under the test clock)
   - a dispatch with `{ actor: Actor.Agent({ id: "a1" }) }` journals that
     actor on every event from that command
   - listener-enqueued dispatches keep their own actor through the drain
   - `runSync` dispatch still completes synchronously with subscribers fired
3. `@cab/router`: slice event change (`message` for `cause`), saga actor
   threading, observed-as-`System`, failure message derivation.
4. `@cab/router` tests: update fact assertions; add cases —
   - outcome facts inherit the requested actor
   - observed facts are `System`
   - failed navigation journals a string `message`, never a raw cause
5. `@cab/router-solid`: hooks stamp `Actor.Human()` by default; optional
   override; port `onEvent` assertions to the enriched shape.
6. `@cab/store` README: document `Actor`, the enriched `Sequenced`, and
   `DispatchOptions` with a short attribution example.
7. Focused sensors per package, then close-out sensors.

## Stability Rules

- Attribution is metadata: `decide` and `reduce` never see the actor. If a
  domain wants actor-dependent business rules, that is a command payload
  design question in that domain, not a store feature.
- The store never invents attribution: it stamps time and sequence
  (mechanical facts) but only records the actor it was told. Defaulting to
  `System` is the honest unknown.
- Journal facts remain plain serializable data — no functions, no `Error`
  instances, no `unknown` escape hatches in any event type that lands in a
  journal.
- Keep the diff to the three packages plus the store README; the playground
  needs no changes.
- Do not add correlation IDs, actor auth, or event schemas while
  implementing, no matter how adjacent they feel.

## PID Sensors

Focused sensors during the loop:

- `pnpm --filter=@cab/store run tsc | lint | test:unit`
- `pnpm --filter=@cab/router run tsc | lint | test:unit`
- `pnpm --filter=@cab/router-solid run tsc | lint | test:unit`

Close-out sensors:

- `pnpm fmt`
- `pnpm fmt:check`
- `pnpm tsc`
- `pnpm lint`
- `pnpm turbo run test:unit`

The mission-level sensor is the setpoint example, executable: a journal
where a human navigation, its inherited outcome, and an external observation
are distinguishable at a glance by `actor` and ordered by both `sequence`
and `at`.
