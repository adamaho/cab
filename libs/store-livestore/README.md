# @cab/store-livestore

**Status: prototype.** This package evaluates [LiveStore](https://livestore.dev)
(0.4.0 stable) as the event-sourced data layer under cab's mission: multiplayer
interfaces shared by humans and agents. It is not a production library; it
exists to answer "should cab build on LiveStore?" with running code, and its
findings feed the store design doc.

## What cab adds on top of LiveStore

LiveStore provides the eventlog, SQLite materialization, reactive queries, and
sync. Cab layers the mission-specific pieces the prototype demonstrates:

- **Commands over raw commits** (`command.ts`): every write is a named,
  described, schema-validated command whose `decide` consults current state and
  can refuse with an agent-readable reason. LiveStore alone lets any caller
  commit any event.
- **Actor provenance** (`actor.ts`): every event carries `{ kind: human|agent,
id }` in addition to LiveStore's device-level `clientId`/`sessionId`.
- **Agent introspection** (`describeCommands()`): the full write surface as
  names, descriptions, and JSON Schemas — discoverable without reading source.
- **History-aware compensation** (`undoLastFilterChangeBy`): undo one actor's
  last change by committing a new attributed fact; history is never rewritten.
- **Journal projection + rendering** (`journal.ts`): ordered facts with
  provenance, plus plain-language rendering per fact — the hook where a
  semantic (vector) index would attach.
- **Change-only subscriptions** (`reactivity.ts`): LiveStore notifies query
  subscribers on every write to a read table; `subscribeDistinct` restores
  value-change-only notification.
- **Multi-client in-memory sync backend** (`memory-sync-backend.ts`):
  LiveStore's `makeMockSyncBackend` serves one client; this one broadcasts, so
  human-and-agent multiplayer runs entirely in tests.

The reference domain (`invoices.ts`) is an invoice board with filters — chosen
because "an agent applies a filter and the human rewinds it" is the mission's
canonical interaction.

## Running

```bash
pnpm --filter=@cab/store-livestore run test:unit
```

The suite doubles as the assessment record: tests pin measured LiveStore
behavior (per-table subscriber granularity, confirmed-only event streaming)
and one `it.fails` test pins a LiveStore 0.4.0 defect where a client that
rebases after racing pushes reports `isSynced: true` while its materialized
state is missing the upstream event.

## Dependency isolation

LiveStore 0.4.0 requires `effect ^3.21.x` while the workspace catalog is on
the effect 4 beta. This package pins its dependency set through the
`livestore` named catalog in `pnpm-workspace.yaml`; nothing here is imported
by other workspace packages.
