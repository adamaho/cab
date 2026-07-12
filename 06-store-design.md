# Cab Store — Public API Design

**Status: draft for review** · **Date:** 2026-07-11
· **Inputs:** `05-store-livestore-assessment.md`, `libs/store-livestore` prototype,
`libs/store` (v1) review, theatre-mode architecture discussion

## Summary

`@cab/store` is the data and persistence layer for **everything that happens
in a cab interface**: domain changes, external data ingest, navigation,
component-level interactions, and — later — multiplayer sync between humans
and agents. All of it flows through one command surface into **one
totally-ordered journal**, and all state is a fold of that journal.

The reference architecture is a game replay system (CoD theatre mode, Source
demos): record semantic state changes plus periodic keyframes, derive every
view — including the live UI, history scrubbing, audit lenses, and the
agent's perception — from the recorded stream. Cab is that architecture for
web interfaces, browser-local first.

The engine underneath (LiveStore first) owns the eventlog, ordering, rebase,
storage, and reactive SQLite. Cab owns what makes the interface multiplayer
between humans and agents: commands, actors, introspection, the journal
contract, snapshots/scrubbing, and subscription guarantees. **No engine type
appears in any public signature** — the prototype demonstrated why this is
non-negotiable (LiveStore 0.4.0 stable carries a disqualifying rebase defect;
the fix lives on a differently-shaped dev line). The engine must be swappable
or forkable without breaking applications.

## Principles

1. **The interface is the domain.** Every semantic interaction — a filter
   applied, a route change, a dropdown opened, an item selected — is a
   command that produces journaled events. An agent's model of the screen is
   only as complete as the journal; interactions that bypass it are blind
   spots.
2. **One journal.** All slices (domain, router, screen, ingest) share a
   single total order. Cross-layer causality — _agent filtered → refresh
   completed → human navigated → agent opened the export menu_ — is a
   property of the substrate, not a reconstruction.
3. **Gestures coalesce into semantics.** Continuous input (mousemove, raw
   scroll, per-keystroke typing) is not journaled per sample; it is
   quantized to its semantic commitment: `ScrolledTo { row }`,
   `DragCompleted { from, to }`, `InputCommitted { field, value }`. This is
   the granularity agents act at, and the same quantization game replay
   systems use.
4. **Scope governs consumption, not recording.** A session-scoped event is
   still recorded once in the one journal; scope controls which participants
   fold it into their state (and, later, which sessions it syncs to).
5. **Retention is maintenance, not a recording decision.** Micro-interaction
   history may age out aggressively; domain facts live forever. Both are
   policies applied to a recorded log — "don't record" is not a compaction
   strategy.
6. **Replay is fold-only.** `decide` runs exactly once, at the live edge.
   Rewind, scrubbing, and sync replay never re-run validation, so the fold
   must be pure, total, and deterministic — and the UI never needs to be.
7. **Rendering is derived.** The live UI, the scrub view, the screen
   capability registry, journal narration, and future semantic indexes are
   all functions of folded state or of the journal. Nothing presentational
   is authoritative.
8. **Local-first.** Browser-local is the degenerate single-client case of
   the same architecture. Adding the sync backend later changes topology,
   not semantics.

## Package layout

| Package                       | Contents                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `@cab/store`                  | Public API: `defineEvent`, `defineCommand`, `defineSlice`, `createStore`, all types below |
| `@cab/store-engine-livestore` | LiveStore engine adapter (today's `libs/store-livestore`, productized)                    |
| `@cab/store-solid`            | Solid bindings over the store surface                                                     |
| `@cab/store-devtools` (later) | Journal timeline, actor filters, **scrub bar** (theatre mode)                             |
| `@cab/router` (rebased)       | Navigation as a session-scoped slice                                                      |
| `@cab/screen` (later)         | Derived capability registry: what is mounted, what it affords                             |
| `@cab/agent` (later)          | MCP bridge: screen → resources, commands → tools, journal → context                       |

## Core concepts and API

### Actors

```ts
type ActorKind = "human" | "agent";

interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}
```

Every dispatch requires an actor; every fact carries one. Device identity
(client/session ids) is engine metadata and stays out of domain events.
Attribution is client-asserted until a sync backend exists; verifying it at
the sync boundary is a server-tier concern (see Load-bearing requirements).

### Events

```ts
const filterApplied = defineEvent({
  name: "v1.FilterApplied", // versioned, immutable once shipped
  schema: Schema.Struct({
    // Standard Schema-compatible
    field: FilterField,
    value: Schema.NullOr(Schema.String),
  }),
  scope: "global", // "global" | "session" | "client"
  retention: "permanent", // "permanent" | "compactable" | "ephemeral"
  render: (args, actor) =>
    args.value === null
      ? `${actor.label} cleared the ${args.field} filter`
      : `${actor.label} filtered by ${args.field} = ${args.value}`,
});
```

- **`scope`** — who folds this event into state: everyone (`global`), one
  viewport (`session`), one device (`client`). All scopes land in the same
  journal.
- **`retention`** — journal maintenance class: `permanent` (domain facts),
  `compactable` (interface history that keyframes may subsume),
  `ephemeral` (micro-interactions kept in a bounded recent window).
- **`render` is required.** History that cannot be narrated cannot be
  audited, searched, or embedded. Rendering feeds devtools, journal views,
  and the future vector index.
- **`redact`** (optional) — per-field redaction applied before a fact is
  persisted or leaves the process. Secrets can never be retroactively
  removed from a replicated log, so exclusion happens at record time.
- The actor is **not** part of the event schema; the store injects it into
  the fact envelope. (The prototype carried it in args; this design removes
  that duplication.)

### Commands

```ts
const applyFilter = defineCommand({
  name: "applyFilter",
  description:
    "Apply or clear (value: null) a filter on the invoice board. " +
    "Applying the current value is a no-op.",
  args: Schema.Struct({
    field: FilterField,
    value: Schema.NullOr(Schema.String),
  }),
  decide: (ctx, args, actor) => {
    const current = ctx.query(filters.get(args.field))?.value ?? null;

    if (current === args.value) return []; // idempotent no-op
    return [filterApplied(args)]; // events to commit
  },
});
```

- `decide` is synchronous and pure over `ctx.query` (current materialized
  state). It returns events, or throws `CommandRejected(reason)` for a loud,
  agent-readable refusal.
- Async validation (server checks, I/O) is **not** `decide`'s job; it
  belongs to process managers layered above the store (as the router's
  navigation saga does today). Sync `decide` keeps dispatch deterministic.
- **Convergence watch:** LiveStore is building an experimental Commands API
  (PR #995, RFC-0002 "command replay") with post-rebase re-validation to
  detect invariant violations when concurrent actors race. Cab's `decide`
  runs once and its events survive rebase unconditionally — acceptable
  browser-local, but multi-actor sync wants replay-style conflict detection.
  Track their RFC; adopt the concept (or their API) when sync lands.

### Slices

```ts
const invoices = defineSlice({
  name: "invoices",
  state, // tables + materializers (see "State definition" below)
  events: { filterApplied, invoiceAdded, invoiceStatusChanged },
  commands: { applyFilter, addInvoice, changeInvoiceStatus, undoLastFilterChangeBy },
});
```

A slice is the domain unit: its events, its state projection, its command
surface. Multiple slices compose into one store and share the global order —
per-slice logs would make "rewind the app" undefined.

### Store

```ts
const store = await createStore({
  slices: [invoices, routerSlice],
  engine: livestore({ storeId: "workspace-42", adapter }),
  keyframes: { everyEvents: 500, everyMs: 30_000 }, // seek/compaction index
});
```

Surface (all engine-neutral):

```ts
interface CabStore {
  // Writes — the only write path.
  dispatch<TCommand>(name: TCommand, args: ArgsOf<TCommand>, actor: Actor): DispatchResult;

  // Reads (live head).
  query<T>(q: Query<T>): T;
  subscribe<T>(
    q: Query<T>,
    listener: (value: T) => void,
    options?: {
      equals?: (a: T, b: T) => boolean; // default: deep value equality
    },
  ): Unsubscribe;

  // History.
  readonly journal: {
    facts(range?: SequenceRange): ReadonlyArray<Fact>;
    onFact(listener: (fact: Fact) => void): Unsubscribe;
    render(fact: Fact): string; // narration via event render
  };

  // Theatre mode: bounded-cost seek to any point in history.
  stateAt(sequence: number): HistoricalView; // nearest keyframe + fold forward

  // Agent surface.
  describeCommands(): ReadonlyArray<CommandDescription>;

  // Sync (no-op locally; real once a backend exists).
  syncStatus(): SyncStatus;
  onSyncStatus(listener: (status: SyncStatus) => void): Unsubscribe;

  shutdown(): Promise<void>;
}

interface HistoricalView {
  query<T>(q: Query<T>): T; // read-only; no dispatch, no subscribe
  readonly sequence: number;
}

interface Fact {
  readonly sequence: { readonly global: number; readonly client: number };
  readonly name: string;
  readonly args: unknown; // post-redaction
  readonly actor: Actor;
  readonly at: number; // committed wall-clock ms
  readonly origin: { readonly clientId: string; readonly sessionId: string };
  readonly scope: "global" | "session" | "client";
  readonly status: "pending" | "confirmed"; // always "confirmed" locally
}

interface DispatchResult {
  readonly events: ReadonlyArray<{ name: string; args: unknown }>;
  readonly rejected?: string; // CommandRejected reason, verbatim
}
```

Guarantees cab makes (and tests), independent of engine behavior:

- **Change-only subscriptions.** A subscriber never fires for a
  value-identical result (prototype finding: the engine notifies per-table;
  cab adds the cutoff).
- **Complete local journal.** `journal.facts()` includes every locally
  committed fact immediately (prototype finding: the engine's public stream
  is confirmed-only; the adapter bridges, and `status` exposes the lifecycle
  honestly once sync exists).
- **Bounded seek.** `stateAt(seq)` costs at most one keyframe load plus one
  keyframe-interval of folding — never a replay from genesis.
- **Rejection is data.** A refused command returns `rejected`; nothing
  throws across the dispatch boundary.
- **History is append-only.** Undo and rewind are compensating commands
  producing new attributed facts; nothing rewrites the log. Scrubbing reads
  history; "restore to here" dispatches compensation.

### History, keyframes, and scrubbing (theatre mode)

The journal is the demo file; keyframes make it seekable in real time:

- On the keyframe policy boundary (`everyEvents`/`everyMs`), the store
  serializes the materialized state (for the LiveStore engine: an SQLite
  image export — UI-scale state is small) keyed by journal sequence.
- `stateAt(seq)` loads the nearest keyframe ≤ seq and folds the remaining
  events forward — bounded, scrub-bar-fast, no simulation determinism
  required because replay is fold-only over recorded facts.
- Keyframes double as the **compaction mechanism**: `ephemeral` and
  `compactable` events older than a policy horizon can be truncated while
  keyframe-granularity scrubbing remains available beyond it — exactly how
  demo files age.
- The mission-level acceptance test for this design is the devtools scrub
  bar: pause the interface at any sequence and see every "player on the
  map" — route, filters, data, open panels, and the agent's actions
  mid-flight.

### Event taxonomy

| Layer              | Examples                                                                 | Scope            | Retention                 |
| ------------------ | ------------------------------------------------------------------------ | ---------------- | ------------------------- |
| Domain facts       | invoice added, filter applied                                            | global           | permanent                 |
| Interface state    | navigation, panel layout, selection                                      | session          | compactable               |
| Micro-interactions | dropdown opened, focus moved (coalesced)                                 | session          | ephemeral                 |
| Data ingest        | `RefreshRequested`, `RefreshCompleted { source, requestHash, rowCount }` | global or client | permanent (metadata only) |

Ingest payloads (external API responses) are **not** journaled: intent and
outcome events carry small metadata and a request hash; payload rows live in
ordinary cache tables referenced by that hash. The journal keeps the
epistemic history ("what did we know, when, from where") without the
tonnage.

### The screen layer (sketch — own design doc later)

`@cab/screen` is the derived capability registry: components register
`{ id, role, description, commands }` on mount and revoke on unmount.
`screen.describe()` gives an agent the contextual tree of what exists right
now and what each surface affords — the accessibility tree rebuilt as a
first-class API. The registry itself is derived (render is already a
function of folded state, so journaling registrations would record what the
fold already determines); every _interaction_ with a capability is a
journaled command, and dispatching against a stale capability is rejected
with a reason. Screen + commands + journal complete the agent loop:
perception, action, memory — mapped mechanically to MCP resources, tools,
and context by `@cab/agent`.

### State definition (the one non-portable seam)

Tables and materializers are written in the engine's schema language
(LiveStore's `State.SQLite`) behind a `defineState(engineState)` passthrough.
Accepted for v1: owning a state DSL while there is exactly one engine is
speculative work. The seam is contained to one file per slice; nothing
downstream of `createStore` sees engine types.

### Framework bindings (`@cab/store-solid`)

Thin wrappers over `subscribe`/`query` with Solid signal semantics —
`useQuery(store, q)` returning an accessor, change-only by construction.
Solid 2.0's async primitives map onto fact `status` (pending → optimistic
UI) when sync lands; out of scope for this review.

## Load-bearing requirements

Promoted from footnotes by the everything-is-an-event commitment:

1. **Compaction and keyframes are core store capabilities**, not deferred
   optimizations. This tightens the engine gate: LiveStore's event
   snapshotting issue (#465) is open, so cab's retention layer must work
   above the engine regardless.
2. **Redaction at record time.** A journal of all interface activity is also
   a surveillance log; `redact` on `defineEvent` and a documented "secrets
   never enter the journal" rule ship in slice 1, not later.
3. **Hot-path budget as a benchmarked invariant.** Dispatch → decide → fold
   → local commit must stay sub-millisecond for micro-interaction commands
   (game replay data rates are orders of magnitude higher than semantic UI
   events, so this is achievable — but it gets a benchmark, not an
   assumption).
4. **Actor verification is deferred, not forgotten.** Locally, actors are
   honest by construction. The moment a sync backend exists, attribution
   must be verified at the sync boundary — clients cannot be trusted to
   stamp `kind: "human"` truthfully.

## Open questions for review

1. **Actor binding.** Per-dispatch (`dispatch(name, args, actor)`) as the
   primitive, with `store.as(actor)` sugar? Proposal: yes.
2. **Package naming.** New API takes over the `@cab/store` name (v1 is
   unreleased)? Proposal: yes.
3. **`dispatch` return.** Add `confirmed: Promise<ReadonlyArray<Fact>>` so
   sagas and agents can await committed sequence numbers? Proposal: yes.
4. **Session scope implementation.** The engine has `synced`/`clientOnly`
   only; `session` scope is cab-implemented (session id in the fact envelope
   - fold filtering). Confirm this lives in cab rather than waiting on
     engine support.
5. **Keyframe representation.** SQLite image export vs. structured state
   serialization; frequency defaults; storage budget in OPFS.
6. **Compensation altitude.** Per-domain undo (as prototyped) now; extract a
   generic attributed-history helper after two slices?
7. **Engine gate.** Adoption of LiveStore for production waits on the
   post-Effect-v4 main line fixing the rebase materialization defect
   (prototype `it.fails` test is the gate; PR #1386 shows the area is
   actively known upstream). Fallback: fork (Apache-2.0) or implement the
   engine interface over our own log. Watch PR #995 for command-API
   convergence.

## Implementation slices (next gate, in review order)

1. `@cab/store` core: types, `defineEvent` (scope/retention/render/redact),
   `defineCommand`, `defineSlice`, dispatcher with rejection + introspection.
   Pure, no engine.
2. Engine interface + `@cab/store-engine-livestore`: port the prototype;
   fact envelope with injected actor; complete local journal bridge.
3. Subscriptions with equality cutoff + `@cab/store-solid`.
4. Keyframes + `stateAt` + retention policies — theatre mode, with the
   scrub-bar acceptance test in a minimal devtools view.
5. Reference slice (invoices) as executable documentation + the
   multiplayer-ready memory sync harness as a published testing utility.
