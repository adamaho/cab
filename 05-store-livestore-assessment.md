# LiveStore Prototype Assessment

**Date:** 2026-07-10 · **Prototype:** `libs/store-livestore` (`@cab/store-livestore`)
· **LiveStore:** 0.4.0 stable (npm `latest`), node adapter, in-memory storage

## Purpose

Answer with running code: should cab build its event-sourced store on
LiveStore instead of continuing `@cab/store`? The prototype layers cab's
mission-specific requirements — commands, actor provenance, agent
introspection, history compensation, fine-grained reactivity, multiplayer —
over LiveStore and measures what fits, what needs a cab layer, and what is
broken upstream.

The test suite (`test/prototype.test.ts`, 8 passing + 1 pinned expected-fail)
is the evidence; every claim below is asserted there or reproduced in probes.

## What LiveStore gives cab for free

- **Fact envelope**: `{name, args, seqNum{global, client, rebaseGeneration},
parentSeqNum, clientId, sessionId}` — versioned event names, causal parent,
  device identity. This answers most of the provenance/sequencing gaps found
  in the `@cab/store` review.
- **Global total order with optimistic local apply**: commits apply
  synchronously to local state; the backend assigns authoritative order;
  clients rebase on conflict. The two-phase model (sync apply, async confirm)
  is exactly the shape the mission needs.
- **Schema'd events** (effect Schema) with forward-compatible evolution rules
  and unknown-event handling — the serialization story `@cab/store` lacked.
- **Reactive SQLite state**: collections are tables with row identity —
  the entity-collection primitive `@cab/store` was missing.
- **Sync status observability** (`syncStatus()`, pending counts, heads).

## What cab adds (and the prototype proves works)

| Cab layer                                                                         | Result                                                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Commands over raw commits (`decide` + schema-validated args + reasoned rejection) | Works cleanly; `decide` queries materialized state, including history tables                                      |
| Actor provenance (`{kind: human\|agent, id}` on every event)                      | Survives commit, materialization, and the wire to other clients                                                   |
| Agent introspection (`describeCommands()` → names, descriptions, JSON Schemas)    | Free via effect `JSONSchema.make`                                                                                 |
| History compensation (`undoLastFilterChangeBy`)                                   | Undo as a new attributed fact over a `filterHistory` projection; history never rewritten; cross-client undo works |
| Journal projection + plain-language fact rendering (vector-index hook)            | Works, with the confirmed-only caveat below                                                                       |
| Change-only notification (`subscribeDistinct`)                                    | Restores the granularity cab requires (see finding 1)                                                             |
| Multi-client in-memory sync backend                                               | ~120 lines; LiveStore's own mock is single-client                                                                 |

## Findings (measured)

1. **Subscriber granularity is per-table, without value cutoff.** A query
   subscriber is re-notified on every write to any table its query reads, even
   when the result is value-identical (probe: 3 identical deliveries).
   Cross-table isolation holds; callbacks are synchronous. Cab's adapter layer
   must add an equality cutoff (done: `subscribeDistinct`); query re-run cost
   remains O(queries-on-table) per write.

2. **`store.events()` streams backend-confirmed events only.** A store
   without a sync backend never surfaces facts through the public event
   stream, and confirmed facts arrive asynchronously after commit. Journal
   consumers (devtools, vector index) need a sync backend today. Unconfirmed
   streaming is on LiveStore's roadmap.

3. **Blocking defect — rebase drops upstream materialization (LiveStore
   0.4.0).** When two clients' first pushes race, the losing client rebases
   (`e2r1`) and pushes correctly — the backend log and the winning client
   converge — but the rebasing client's materialized state is **missing the
   upstream event while reporting `isSynced: true`**. Deterministic repro:
   simultaneous dispatch diverges; a 150 ms stagger converges. Pinned as
   `it.fails` in the suite. This is precisely the human-and-agent-simultaneous
   scenario at the heart of the mission, so it disqualifies 0.4.0 stable for
   production use. The dev line has a reworked sync engine; retest there.

4. **Version split.** Stable 0.4.0 requires effect 3.21.x; the workspace
   catalog is on the effect 4 beta, which only LiveStore's unpublished dev
   line targets. Isolated via the `livestore` named catalog. Also:
   `adapter-node` exists in stable but is absent from the main branch —
   clarify its future before betting server-side workloads on it.

5. **DX friction, minor.** `Store<TSchema>` generics are invariant, so
   schema-agnostic layers must accept structural types; the shipped mock sync
   backend can't simulate multiplayer. Neither is architectural.

## Verdict

**The architecture is validated; the specific version is not.** The
event-sourced sync model matches the mission almost one-to-one, and every cab
differentiator layered on in ~600 lines without fighting the design. The
things cab would have had to build from scratch (envelope, global ordering,
rebase, schema evolution, reactive SQLite) are LiveStore's core competency;
the things LiveStore doesn't care about (commands, actors, introspection,
compensation, rendering) are exactly cab's value.

Recommended path:

1. **Design cab's public API as its own layer** (next gate: design doc) with
   LiveStore as the first backing engine, keeping the surface portable —
   commands, actors, journal, and subscriptions must not leak LiveStore types.
2. **Track LiveStore's dev line** (effect v4, reworked sync) and re-run this
   suite against it; the rebase defect (finding 3) is the adopt/no-adopt gate.
   Report it upstream with the repro.
3. Treat finding 1 and 2 as adapter responsibilities in the design doc:
   change-only subscription semantics and a local journal tap are cab surface
   guarantees regardless of engine behavior.
