# Cab POC Brief — Event-Sourced Interface with Theatre Mode

**Status: handoff-ready** · **Date:** 2026-07-11 · **Context:**
`06-store-design.md` (full API design), `05-store-livestore-assessment.md`
(engine evaluation — outcome: build bespoke, keep LiveStore as reference)

This brief is self-contained: an implementing agent needs only this document,
`CONTRIBUTING.md`, and the `pid` skill. The POC is the **setpoint reference**
— a working end-to-end demonstration of the desired outcome. Once it exists
and is approved, the production packages will be built by working backwards
from it, slice by slice, replacing its internal layers with real libraries.

## Mission

Cab makes user interfaces multiplayer between humans and agents. The
interface is a shared workspace: every semantic interaction — navigation, a
settings change, a table sort, a row edit — is a **command**, dispatched by
an attributed **actor** (human or agent), producing **events** in a single
totally-ordered **journal**. All state is a fold of that journal. Because
history is complete and attributed, the interface can be rewound and
scrubbed like a game replay (CoD theatre mode): pause at any moment and see
exactly what was on screen and who did what.

The POC proves this loop end-to-end, browser-local, in one small app.

## Desired outcome (setpoint)

A SolidJS single-page app with a devtools pane. All acceptance criteria are
observable by running the app:

1. **Three pages** — `Todos` (table), `Settings`, `About` — navigable via a
   nav bar. Navigation is a command (`navigate`) producing a journaled
   event; the current route is folded state, not router-internal state.
   Browser back/forward integration is a stretch goal, not required.
2. **External data fetching** — the Todos page loads from
   `https://jsonplaceholder.typicode.com/todos` (keyless, no auth). The
   fetch _intent_ and _outcome_ are journaled events
   (`RefreshRequested`, `RefreshCompleted { requestHash, count }` /
   `RefreshFailed { message }`); the **payload is not journaled** — rows
   live in a cache keyed by `requestHash`, and folded state references the
   hash. Refetch is a button (a command) on the page.
3. **Event-sourced interactions everywhere.** Every interaction is a
   command → event → fold, no exceptions:
   - Todos table: sort by column, filter by completion status, select a
     row, toggle a todo's done state (a local domain fact layered over the
     fetched data).
   - Settings: theme (light/dark, visibly applied), table page size.
   - Every event carries `{ actor, at }` in its envelope; every command
     validates via a `decide(state, args)` function that can reject with a
     human/agent-readable reason (rejections are returned, never thrown).
4. **Theatre-mode devtools** (a collapsible pane inside the app):
   - **Journal timeline**: every fact rendered as a plain-language sentence
     ("Human adam sorted todos by title", "Agent bot toggled todo 14"),
     color-coded by actor kind, live-updating.
   - **Scrub bar**: a slider over the journal sequence. Dragging it puts
     the app into a read-only historical view — the _same page components_
     render the folded state at that sequence (route, filters, sort,
     selection, settings, theme, fetched-data reference — everything).
     A "Live" button returns to the head. Dispatch is disabled while
     scrubbing. Refold-from-genesis is acceptable at POC scale; keyframes
     are a stretch goal.
   - **Command palette**: a panel listing every registered command with its
     description and argument schema (the agent-introspection surface).
   - **Simulate agent**: a button that dispatches a scripted sequence of
     commands as `{ kind: "agent", id: "bot" }` (navigate → filter → toggle
     a todo → change theme), visibly interleaving with human facts in the
     timeline. Scrubbing back through the agent's run replays it.
5. **Journal invariants hold and are tested** (vitest): fold determinism
   (refolding the journal reproduces current state), rejection produces no
   events, unknown commands fail loudly, every fact is serializable
   (`structuredClone` round-trips), and scrubbing to sequence N equals the
   state that existed after fact N.

## Tech stack (fixed — do not substitute)

- **TypeScript** (strict, workspace `@cab/tool-tsconfig` base)
- **SolidJS 1.9** + **Vite** + `vite-plugin-solid` (all in the workspace
  catalog) — rendering only; no solid-router, no external state library
- **alien-signals** (workspace catalog) — the reactivity engine under the
  store: one signal per top-level state key is sufficient at POC scale
- **effect Schema** (workspace catalog, effect 4 beta) — command argument
  schemas + JSON Schema generation for the command palette. Use `Schema`
  only; no Effect runtime in the store hot path — dispatch is a plain
  synchronous function
- **vitest** (workspace catalog) for the invariant tests
- Journal persistence: **in-memory** is sufficient; OPFS/localStorage is a
  stretch goal
- **No LiveStore, no network sync, no server** — browser-local only

## Architecture rules

- **Everything is an event.** Every semantic interaction in the app — every
  navigation, sort, filter, selection, toggle, settings change, fetch
  intent and outcome — flows command → decide → event → fold. If an
  interaction changes what the user sees and it is not in the journal, the
  POC has failed its premise.
- **One journal.** Router, settings, table, and fetch events share one
  append-only, totally-ordered log. Facts:
  `{ sequence, name, args, actor: { kind: "human" | "agent", id }, at }`.
- **Commands are the only write path.** `defineCommand({ name, description,
args: Schema, decide })`; `decide` is synchronous, pure over current
  state, returns events or a rejection reason. Replay never re-runs
  `decide` — scrubbing and refolds use the fold only.
- **The fold is pure and total.** `reduce(state, event) → state`, no I/O,
  no clock reads (time lives in the envelope).
- **Rendering is derived.** Components read folded state through the
  store's subscription API; they never own interaction state. The scrub
  view reuses the live components against a historical fold.
- **Gestures coalesce.** No per-keystroke or per-mousemove events; journal
  the semantic commitment (e.g. filter value on change-commit).

## Package structure

One new self-contained package: `shells/poc` (`@cab/shell-poc`). **Do not
modify or import `libs/store`, `libs/router`, `libs/router-solid`, or
`libs/store-livestore`.** Internal folders mirror the future production
slices so extraction is mechanical later:

```text
shells/poc/src/
  store/     journal, fold, dispatch, actors, subscriptions  (→ @cab/store)
  slices/    router, settings, todos, ingest definitions     (→ app slices)
  devtools/  timeline, scrubber, command palette, agent sim  (→ @cab/store-devtools)
  app/       pages, nav, providers                            (→ shell)
```

Standard package scripts (`lint`, `tsc`, `test:unit`, plus `dev` via Vite),
wired like the existing `libs/*` packages.

## Non-goals

Multiplayer sync, persistence guarantees, undo/compensation commands,
keyframe seek optimization, the `screen` capability registry, MCP/agent
bridge, accessibility polish, visual design polish (keep it plain and
readable; no design system).

## Verification (pid sensors)

- `pnpm --filter=@cab/shell-poc run tsc | lint | test:unit`, then repo
  `pnpm check`.
- Manual walkthrough as the mission-level sensor: load app → navigate all
  three pages → refetch todos → sort/filter/toggle/select → change theme →
  run "Simulate agent" → scrub the timeline to before the agent's run and
  confirm the entire interface (route included) matches that moment → return
  to Live.

## Handoff notes

- Load and apply the `pid` skill before implementing; this document's
  "Desired outcome" section is the setpoint, the sensors above are the
  measurement loop.
- Follow `CONTRIBUTING.md` for workspace layout, JSDoc on public exports
  within the package, catalog-pinned dependencies, and commit format
  (`feat(shell-poc): ...`).
- Favor the smallest implementation that meets the setpoint; this code will
  be studied and progressively replaced, so clarity beats cleverness and
  layer boundaries beat abstraction depth.
