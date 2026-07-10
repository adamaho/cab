# Router Pipeline Architecture Review

Date: 2026-07-10

Scope: the current working-tree implementation from `@cab/store` through
`@cab/router` to `@cab/router-solid`, including their tests, READMEs, the
playground integration, and design documents `02-router-design.md`,
`03-router-solid-design.md`, and `04-journal-metadata-design.md`.

## Executive Verdict

The direction is sound, but the current architecture is not yet capable of
meeting Cab's full mission without several important changes to its contracts.

The good news is that the part worth preserving is the hardest conceptual part:

- callers express intent as typed commands;
- process managers own effects and turn outcomes into facts;
- projections are pure folds over those facts;
- readers and writers are separate capabilities;
- framework adapters render projections rather than owning domain rules.

That is a strong foundation for an interface an agent can operate without
guessing from screenshots. The router is a useful vertical proof of that model.

The bad news is that the implementation currently provides a local,
single-process, short-lived event log, not a multiplayer session runtime. It can
silently lose human navigation observations, leave accepted commands without a
terminal outcome, expose facts before their projection is committed, lose the
journal when a Solid provider remounts, and cannot identify which human or agent
caused a fact. Separate stores would also produce separate journals with no
session-wide order.

My recommendation is therefore a **conditional go**:

- Keep the command -> process manager -> fact -> projection architecture.
- Do not treat the current `Store` journal or `SolidRouter` lifetime as the
  eventual session model.
- Make correctness, correlation, global session ordering, replayable
  observation, and framework-independent session access the next milestone.
- Delay route matching, loaders, actions, and other conventional router features
  until that milestone is complete.

Current readiness, stated bluntly:

| Question                                                | Verdict                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| Is this a good router prototype?                        | Yes.                                                             |
| Is the module direction worth continuing?               | Yes.                                                             |
| Is the current journal trustworthy enough for an agent? | No.                                                              |
| Is it currently multiplayer?                            | No. It has observable local facts, not shared-session semantics. |
| Is it reversible?                                       | No.                                                              |
| Is it safe for long-lived sessions?                     | No.                                                              |
| Is it performant for ordinary navigation volume?        | Probably yes.                                                    |
| Is it performant at Cab's eventual session scale?       | No evidence, and current journal growth will not scale.          |

## Mission Evaluation

The mission in `CONTRIBUTING.md` asks for a living interface that is shared by
humans and agents, directly commandable, observable, reversible, eventful, and
precise.

| Mission property                | Current assessment                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent as commands              | Strong foundation. Router writes are typed intent and outcome commands are private to the saga entrance.                                                            |
| State as understandable history | Partial. State folds from retained facts, but facts lack actor, time, command identity, schema version, and reliable completeness.                                  |
| Agent inspection                | Partial in core, weak in Solid. `StoreReader` is useful, but the adapter-owned runtime and retained journal are not exposed through a shared imperative capability. |
| Agent navigation                | Partial. The core can dispatch typed commands, but Solid only exposes fire-and-forget UI hooks. There is no receipt or stable session handle.                       |
| Observability                   | Partial. State and fact streams exist, but observation can be lost, callbacks can die silently, and snapshot-to-live handoff is not gap-free.                       |
| Reversibility                   | Missing. There are no back, forward, replace, undo, or compensating commands.                                                                                       |
| Eventfulness                    | Partial. Owned navigation is recorded well on the happy path, but external browser actions are intentionally coalesced and failures can disappear.                  |
| Precision                       | Promising but not yet sufficient. Types and sequencing are strong; canonical URL mismatch, missing correlation, and non-atomic commits undermine factual precision. |
| Safety                          | Partial. Read/write separation is strong; interruption, lifecycle ownership, silent stale callbacks, and absent remote authorization are unresolved.                |
| First-class collaboration       | Missing. There is no durable session identity, shared ordering, actor model, transport, presence, authorization, or conflict policy.                                |

The architecture advances the mission, but it does not yet satisfy it. The
distinction matters: passing the current tests proves the local contracts as
written, while some of those contracts are weaker than the mission requires.

## Current Pipeline

```text
Solid component
  -> useRouterNavigate / useRouterDispatch
  -> SolidRouter-owned ManagedRuntime
  -> Router process manager
  -> private Store dispatch
  -> journal append
  -> pure projection fold
  -> StoreReader subscription
  -> RouterBridge
  -> Solid signal

Browser popstate
  -> History.changes
  -> Router observation loop
  -> private Store dispatch
  -> NavigationObserved fact
  -> projection and Solid signal
```

The module seams are mostly in the right places:

- `SliceDefinition` contains pure domain decisions and reductions
  (`libs/store/src/slice.ts:14-19`).
- `Store` owns sequencing, journaling, serialization of dispatch, and reactive
  projection machinery (`libs/store/src/store.ts:112-239`).
- `Router` owns history I/O and exposes only user intent plus a read-only reader
  (`libs/router/src/router.ts:25-43`).
- `History` is a real adapter seam with browser and memory adapters
  (`libs/router/src/history.ts:28-40`, `53-83`, `97-136`).
- `RouterBridge` is the only implementation that knows both the store reader and
  Solid primitives (`libs/router-solid/src/bridge.ts:1-97`).

That separation has good depth. Deleting the router process manager would force
history sequencing, deduplication, failure mapping, and observation handling
into callers. Deleting the Solid bridge would force every hook to manage
subscriptions and cleanup. Both modules earn their interfaces.

The weak seam is lifetime and session ownership. Today the Solid provider owns
the Effect runtime, the runtime owns the core router, and the core router owns the
journal. That makes a framework mount the de facto owner of session history. For
Cab, the shared session should own the runtime and history; framework views
should attach to it.

## Findings

### P0: There is no session-wide journal or session identity

`@cab/store` supports one slice per store and explicitly has no cross-slice
composition (`libs/store/README.md:27-38`). `Router.layer` creates a private
store for the router (`libs/router/src/router.ts:61-64`). A future editor,
dialog manager, selection model, and router built the same way would each have
their own sequence beginning at zero.

That makes it impossible to answer session-level questions reliably:

- Did the human navigate before or after the agent changed the document?
- Which state did an agent inspect before issuing a command?
- Which facts form the causal result of one command across domains?
- What cursor can a reconnecting observer resume from?

Timestamps do not solve total ordering, and merging independent in-memory
journals after the fact does not create causality.

This is the biggest architectural gap between the router proof and the Cab
mission. Do not solve it by building one giant global reducer. Introduce a
session-level append and sequencing authority while allowing domain projections
to remain local.

### P0: Store append and projection commit are not failure-atomic

The store appends and publishes every event before reducing the events into a
candidate state (`libs/store/src/store.ts:123-129`, `158-169`). If a reducer
defects on the first or a later event, the retained journal already contains
facts that were never folded into the state. This contradicts the documented
guarantee that replay always equals current state
(`libs/store/README.md:318-327`).

Publication also happens before `SubscriptionRef.set`. A journal subscriber can
receive a fact and read the pre-fact projection. Whether that occurs depends on
scheduling rather than a documented consistency contract.

For an agent, this is not an implementation detail. A fact must mean the session
accepted and committed it. The minimum safe transaction is:

1. Decide all events.
2. Reduce them into a candidate projection without mutating shared resources.
3. Atomically reserve sequences and commit journal plus projection.
4. Publish notifications only after the committed snapshot is readable.

If durable storage arrives later, this same seam should become the durable
append transaction rather than acquiring a second transaction model.

### P0: External human navigation is intentionally lossy

The router buffers history notifications with capacity one and a sliding
strategy (`libs/router/src/router.ts:80-83`). It ignores the href supplied by
`History.changes`, waits for the router semaphore, and later reads only the
current href (`libs/router/src/router.ts:66-83`). Current-read failures are
silently converted to `Effect.void` (`libs/router/src/router.ts:68-75`).

The tests explicitly accept coalescing (`libs/router/test/router.test.ts:257-285`).
The delayed-navigation test demonstrates that an external `"/a"` can disappear
from the journal entirely (`libs/router/test/router.test.ts:480-543`).

This may be an acceptable current-state synchronization policy for a normal UI
router. It is not an acceptable collaboration-history policy. A human can use
back or forward while an agent navigation is pending and leave no fact that the
human acted.

Choose an honest contract:

- Prefer lossless ordered observations for collaboration. Journal every emitted
  href and define bounded overflow as an explicit fact or terminal diagnostic.
- If coalescing is retained, call the stream an invalidation signal rather than
  navigation history, and record `ObservationsCoalesced` and
  `ObservationFailed` facts.

Silent loss must not remain a valid state.

### P0: Accepted commands have no identity, receipt, or guaranteed terminal outcome

Store, router, and Solid dispatch all return `void`
(`libs/store/src/store.ts:64-84`, `libs/router/src/router.ts:25-40`,
`libs/router-solid/src/hooks.ts:36-61`). Router acceptance is inferred by
reading journal length before and after store dispatch
(`libs/router/src/router.ts:86-98`).

The router appends `NavigationRequested` before executing `history.push`, but
only typed failure or normal success appends an outcome
(`libs/router/src/router.ts:99-120`). Interruption, a defect, or a never-ending
adapter can leave a request without an outcome. A hung push also holds the one
router semaphore, blocking later navigation and external observation.

The README promises exactly one outcome per accepted navigation
(`libs/router/README.md:285-291`), but the implementation only guarantees this
on the typed, terminating path.

I disagree with the decision in `04-journal-metadata-design.md:27-32` to defer
correlation IDs. Actor attribution is not enough:

- the same agent can issue concurrent commands;
- interruption already breaks synchronous adjacency;
- loaders, redirects, retries, and remote transport will make adjacency less
  reliable;
- reconnecting clients need to ask for one command's status without pattern
  matching neighboring facts.

Every command should receive a `commandId` and a receipt. Every resulting fact
should carry that `commandId`, and nested work should carry `causationId` or a
trace identifier. Accepted commands need an explicit terminal state such as
committed, rejected, failed, cancelled, or timed out.

### P0: Solid owns and hides the session instead of adapting it

`SolidRouter` creates and owns a `ManagedRuntime`
(`libs/router-solid/src/router.ts:42-55`). Unmount disposes it
(`libs/router-solid/src/router.ts:90-105`). Remount creates a new runtime, which
creates a new core router, store, journal, and sequence space. The remount test
checks current-state catch-up but not journal continuity
(`libs/router-solid/test/provider.test.tsx:234-256`).

The package entrypoint exports `SolidRouter` only as a type
(`libs/router-solid/src/index.ts:3-9`). The object has no public imperative
inspection or dispatch interface. `useRouter()` therefore returns an opaque
token to consumers outside the package's internal static methods. Retained
history is available only if code separately resolves the hidden Effect router,
which normal consumers and external agents cannot do.

This is backwards for a shared living interface. A session should survive view
mounts, layout transitions, HMR, and framework adapter replacement. Both human
UI hooks and agent tools should use capabilities derived from the same session.

Recommended ownership:

```text
Session runtime
  owns command protocol, global journal, projections, transport, and lifetime

Router domain module
  registers commands/facts and performs History effects within that session

Solid adapter
  attaches subscriptions to an existing session and detaches on cleanup
  does not create or destroy session history
```

### P0: Snapshot plus live stream cannot be consumed without gaps

`reader.journal` is a retained snapshot and `reader.journalChanges` is live-only
(`libs/store/README.md:218-223`). There is no atomic operation to read through
sequence N and subscribe from N+1. An event can be appended between those two
operations.

This is a fundamental problem for devtools, agents, transports, and reconnecting
clients. The Solid `onEvent` startup race is one symptom: the bridge is mounted
before the live journal consumer starts (`libs/router-solid/src/router.ts:69-84`),
so immediate commands can occur before observation is ready.

The journal interface needs cursor semantics, for example:

```text
readFacts(afterSequence, limit)
subscribeFacts(afterSequence)
```

The implementation must guarantee no gap between retained catch-up and live
delivery. A replayable hub backed by the journal is more useful than exposing an
uncoordinated `Ref` snapshot and live `PubSub`.

### P1: Browser commits can project a different href from the browser

`window.history.pushState` accepts relative, query-only, hash-only, and
same-origin absolute URLs (`libs/router/src/history.ts:65-74`). The router
commits the original command string rather than the resulting canonical
location (`libs/router/src/router.ts:99-118`).

Examples from `/account/` include:

- `navigate("settings")` can produce browser location `/account/settings` but
  projected state `"settings"`;
- `navigate("?tab=profile")` can produce `/account/?tab=profile` but projected
  state `"?tab=profile"`;
- an absolute same-origin URL can remain absolute in state while `current`
  always returns pathname, search, and hash.

Existing browser coverage tests only a root-relative path
(`libs/router/test/router.test.ts:603-683`). `History.push` should return the
canonical committed href, or the router should read `history.current` after a
successful push and use that observed value in `NavigationCommitted`. Keep the
requested href on the request fact so intent and outcome remain distinguishable.

### P1: Facts lack multiplayer metadata and are not wire-safe

`Sequenced` contains only `sequence` and `event`
(`libs/store/src/event.ts:12-15`). Dispatch accepts no actor or origin. Router
failures retain `cause?: unknown` (`libs/router/src/slice.ts:95-109`), and the
saga places raw causes into retained history (`libs/router/src/router.ts:101-109`).

`04-journal-metadata-design.md` correctly proposes actor, timestamp, and
serializable failure data. Those are required, not optional polish. I would
extend that design before implementation with:

- `sessionId`;
- `eventId`;
- `commandId`;
- optional `causationId` and `correlationId`;
- global session sequence;
- schema name and version;
- actor identity and actor kind;
- recorded time, with client-issued time kept separate if needed;
- serializable error code, message, and safe details.

Attribution is not authorization. A remote agent path will also need capability
scopes and policy enforcement at dispatch, not merely an `Actor.Agent` label.

### P1: Solid lifecycle failures are silent and ownership is unsafe

One `SolidRouter` stores one global `mounted` flag, `mountId`, bridge, and runtime
(`libs/router-solid/src/router.ts:58-63`, `181-189`). Mounting the same instance
under two providers invalidates the first mount. Unmounting either can tear down
the runtime used by the other. This assumption is neither enforced nor tested;
the current independence test uses two different router instances
(`libs/router-solid/test/provider.test.tsx:181-204`).

Other silent failure paths include:

- `onEvent` runs inside the one stream fiber; if the callback throws, all later
  event observation stops (`libs/router-solid/src/router.ts:75-85`);
- provider startup and navigation fibers are discarded, so defects and layer
  construction failures have no diagnostic channel
  (`libs/router-solid/src/router.ts:65-87`, `124-143`);
- callbacks invoked after unmount use optional chaining and silently drop the
  command (`libs/router-solid/src/router.ts:124-143`);
- runtime disposal is fire-and-forget (`libs/router-solid/src/router.ts:100-105`).

These are especially damaging because event observation is the feature an agent
would depend on. Until session ownership moves out of Solid, reject duplicate
mounts loudly, make mount return a mount-specific disposer, isolate callback
failures per fact, and expose runtime exits through a diagnostic channel.

### P1: The journal implementation will not scale to long-lived sessions

Every fact append spreads the full retained journal into a new array
(`libs/store/src/store.ts:123-129`). For F facts, one append is O(F) and total
copying over the session is O(F^2). The retained journal and PubSub are unbounded
(`libs/store/src/store.ts:116-118`). A lagging subscriber can accumulate an
unbounded queue.

Every state transition also attempts a write to every top-level signal
(`libs/store/src/store.ts:97-104`). Equality cutoff avoids unnecessary listener
notifications, but dispatch work is still O(K) for K top-level keys.

This is harmless at ordinary router volume and dangerous as a general-purpose
foundation for long-lived, eventful sessions. Use append-oriented chunks or a
durable log, cursor-based reads, bounded subscriber policies, snapshots, and
compaction. Do not optimize the Solid bridge first; journal semantics and data
structure are the dominant issue.

### P1: Router serialization is safe for ordering but too coarse for future work

The router holds one semaphore across request append, all history I/O, and
outcome append (`libs/router/src/router.ts:86-125`). This gives deterministic
happy-path ordering and is a reasonable starting point for low-frequency
navigation. It also means one stuck adapter blocks all later commands and human
observations.

This will become worse if loaders, guards, redirects, or remote coordination are
placed under the same permit. Preserve ordering through explicit command state
and correlation rather than relying forever on one unbounded critical section.

### P1: Reversibility is absent, not merely incomplete UI

The only public command is `NavigationRequested`
(`libs/router/src/slice.ts:28-40`). `HistoryShape` only supports `push`,
`current`, and `changes` (`libs/router/src/history.ts:28-32`). The router README
correctly marks back and forward as future work (`libs/router/README.md:43-50`).

Cab's mission explicitly calls for reversibility. Navigation needs typed
`BackRequested`, `ForwardRequested`, and `ReplaceRequested` commands with
outcome facts. More generally, domains need an explicit reversal strategy:

- true inverse commands where an inverse exists;
- compensating commands where external effects cannot be undone;
- checkpoints and restoration where replay is expensive;
- clear facts when reversal is impossible or rejected.

Reversibility should never delete or rewrite history. A reversal is new intent
and new facts.

### P2: Browser observation has a startup race and SSR fails opaquely

Core router construction reads `history.current` before the forked browser
stream installs its event listener (`libs/router/src/router.ts:61-84`). A
popstate in that window can be lost. The browser test explicitly waits for a
listener-ready signal before emitting (`libs/router/test/router.test.ts:603-649`),
but production has no readiness handshake.

Subscribe first and then re-read current, or define `History.observe` as an
atomic initial snapshot plus changes contract.

`createBrowserRouter` returns `"/"` outside a browser but still installs
`Router.layerBrowser` (`libs/router-solid/src/router.ts:191-215`), whose history
layer fails when `window` is absent (`libs/router/src/history.ts:53-61`). Because
the provider discards the startup fiber, SSR produces a seeded facade over a
failed runtime. Either make browser-only behavior explicit and loud or add an
SSR constructor with request URL and hydration semantics.

### P2: Listener-enqueued store commands can be acknowledged and discarded

During notification, nested dispatch pushes a command into `pending` and
returns (`libs/store/src/store.ts:131-139`). If another listener throws, cleanup
clears all pending commands (`libs/store/src/store.ts:184-192`). The test makes
this behavior explicit (`libs/store/test/store.test.ts:374-400`).

The nested caller receives an enqueue acknowledgement indistinguishable from
success, but its intent can disappear without a fact. This is unsafe for a
command runtime. A typed asynchronous receipt would make eventual disposition
observable. Another defensible design is to disallow synchronous listener
dispatch and expose an explicit post-commit command queue.

### P2: The playground does not prove the accepted adapter design

The Solid design requires removing `RegistryProvider` and
`@effect/atom-solid` (`03-router-solid-design.md:21-39`, `113-117`). The current
playground still imports and mounts `RegistryProvider`
(`shells/playground/src/app.tsx:9`, `31-38`) and still declares the dependency
(`shells/playground/package.json:14-20`).

This is not a deep architecture flaw, but it means the integration proof is not
complete and the shell contradicts the adapter README's claim that no registry
is needed (`libs/router-solid/README.md:75-81`).

### P2: Behavioral verification is not part of the required close-out command

The root `check` script runs formatting, lint, and TypeScript, but not unit tests
(`package.json:5-13`). `CONTRIBUTING.md` calls `pnpm check` the full local
verification command while also saying tests are required. Most important
guarantees in this pipeline are behavioral and cannot be proved by lint or type
checking.

Include `test:unit` in the required close-out path or define and enforce a second
mandatory command in CI.

## What Is Strong

The problems above should not obscure the real strengths.

### The command, fact, and projection split is correct

`decide` is pure intent validation, `reduce` is a pure fold, and I/O stays in the
router process manager. This is far more agent-navigable than implicit URL
mutation spread through components.

### Read and write capabilities are deliberately separated

`StoreReader` excludes dispatch (`libs/store/src/store.ts:9-56`), and the router
keeps the writable store private (`libs/router/src/router.ts:61-64`, `131-135`).
This is a useful local safety seam and a good basis for future remote capability
scopes.

### Outcome fabrication is constrained

Public router dispatch accepts only caller intent, while outcome commands remain
inside the router package (`libs/router/src/slice.ts:16-79`). The type-level test
protects this contract. A committed fact is therefore tied to the process
manager path rather than arbitrary UI code.

### History is behind a real adapter seam

The browser and memory implementations let tests drive owned and external
navigation independently. This is the right place to add canonicalization,
back/forward, readiness, and failure semantics.

### Fine-grained state reactivity is reasonable

The store uses one signal per top-level key, batches writes, and preserves
change-only listener behavior. The Solid bridge creates a per-hook subscription,
catches up from current state after subscribing, and cleans it up with Solid
ownership (`libs/router-solid/src/bridge.ts:40-90`). For current router state,
this is simple and likely fast enough.

### Concurrency intent is explicit

Both store writes and router sagas are serialized, and tests cover gapless
sequences and concurrent navigation. The eventual protocol should evolve beyond
global semaphores, but explicit ordering is a much better starting point than
accidental races.

### Documentation and tests are unusually clear

The READMEs explain contracts and non-goals, and tests pin subtle behavior such
as listener reentrancy, identity folds, selector equality, external observations,
and provider remount. That clarity made it possible to identify where a tested
contract conflicts with the mission rather than merely finding coding mistakes.

## Performance And Scaling Assessment

### What should perform well now

- Router traffic is normally low frequency.
- Pure `decide` and `reduce` functions are cheap.
- One semaphore makes navigation ordering deterministic.
- Top-level signal equality prevents unrelated subscriber notifications.
- Solid consumers subscribe to one route key and selector output uses Solid
  equality cutoff.
- Memory and browser adapters have little overhead on the happy path.

### What will not scale

| Dimension            | Current behavior                  | Scaling consequence                                       |
| -------------------- | --------------------------------- | --------------------------------------------------------- |
| Retained fact append | Full array copy per fact          | O(F^2) cumulative copying                                 |
| Journal retention    | Unbounded memory                  | Long sessions eventually exhaust memory                   |
| Live subscribers     | Unbounded PubSub backlog          | Slow clients can create unbounded pressure                |
| Projection writes    | Every top-level signal considered | O(K) per changed projection                               |
| Router work          | One permit held across I/O        | One hung operation stalls all navigation and observations |
| Solid subscriptions  | One Store subscription per hook   | O(H) callback fanout per href change                      |
| Multiple domains     | Independent journals              | No global order or efficient session replay               |
| Remount              | New runtime and journal           | History and sequence discontinuity                        |

There are no performance budgets or benchmarks, so the pipeline cannot yet be
called performant at mission scale. It is fair to call it performant enough for
the current playground and likely for ordinary client-side navigation.

Before optimization, define budgets for:

- facts per hour and maximum session duration;
- maximum retained history before snapshot or compaction;
- connected observers and allowed lag;
- command-to-fact and fact-to-render latency;
- reconnect catch-up time;
- memory per 100,000 facts;
- behavior when a subscriber cannot keep up.

## Recommended Target Architecture

The smallest creative evolution is a **Session Kernel** above the current domain
stores. It should not become a giant UI store. It should provide shared protocol
and ordering while domains retain their own commands, process managers, and
projections.

```text
Human UI -----------+
                    |
Embedded agent -----+-> Session Capability
                    |     dispatch(command envelope)
Remote agent -------+     inspect(snapshot/cursor)
                          subscribe(after cursor)
                          request reversal
                                |
                                v
                         Session Kernel
                         - identity and actors
                         - command receipts
                         - global sequencing
                         - durable append
                         - schemas/versioning
                         - auth/capabilities
                         - cursor/replay
                                |
             +------------------+------------------+
             |                  |                  |
          Router PM          Editor PM          Dialog PM
             |                  |                  |
          History I/O       Document I/O       UI effects
             |                  |                  |
             +---------- facts and projections ---+
                                |
                      Framework adapters
                      Solid / future adapters
```

An illustrative protocol, not a final TypeScript design:

```ts
interface CommandEnvelope<C> {
  readonly sessionId: string;
  readonly commandId: string;
  readonly actor: Actor;
  readonly expectedRevision?: number;
  readonly command: C;
}

interface FactEnvelope<E> {
  readonly sessionId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly commandId: string;
  readonly causationId?: string;
  readonly actor: Actor;
  readonly recordedAt: number;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly event: E;
}

type CommandReceipt =
  | { readonly _tag: "Rejected"; readonly commandId: string; readonly reason: string }
  | { readonly _tag: "Accepted"; readonly commandId: string; readonly acceptedAt: number };
```

The command's eventual terminal outcome should be queryable or subscribable by
`commandId`. Acceptance and completion should not be conflated.

### Use two collaboration lanes

Not every UI signal belongs in durable history.

- The durable lane records commands, accepted domain facts, failures,
  reversals, and checkpoints. It is replayable and auditable.
- The ephemeral lane carries presence, focus, cursor movement, hover, typing
  previews, and other high-frequency transient observations. It may be lossy,
  but its loss policy is explicit.

This prevents event sourcing from becoming an expensive recording of every DOM
microstate while preserving collaboration-relevant intent.

### Use CRDTs selectively, not as the universal command model

The serialized router model is appropriate because one browser location has one
current value. Concurrent document editing is different. A document domain may
use a CRDT or operation log for mergeable state while still emitting Cab session
facts for actor intent, accepted operations, conflicts, and checkpoints.

The Session Kernel should coordinate protocol and observation without forcing
all domains into the same conflict algorithm.

### Expose semantic capabilities, not arbitrary state mutation

To fulfill the mission, features should register narrow commands and inspection
schemas such as:

```text
router.navigate({ href })
router.back()
editor.replaceSelection({ text })
dialog.confirm({ dialogId })
form.setField({ formId, field, value })
```

An agent should discover these capabilities, inspect the relevant projection and
recent facts, dispatch with an expected revision when safety requires it, and
observe the correlated outcome. It should not receive a generic
`setState(path, value)` escape hatch.

## Prioritized Next Steps

### Gate 1: Make the current pipeline truthful

1. Make store dispatch failure-atomic and publish only after projection commit.
2. Return a typed dispatch receipt rather than inferring acceptance from journal
   length.
3. Canonicalize committed href from the history outcome.
4. Guarantee terminal outcomes for interruption, defects, cancellation, and
   timeout.
5. Replace silent observation failure and implicit coalescing with explicit
   facts or diagnostics.
6. Add browser listener readiness semantics.

Do not proceed to loaders or route matching until these invariants are tested.

### Gate 2: Upgrade the fact protocol

1. Implement actor, time, and serializable failures from
   `04-journal-metadata-design.md`.
2. Amend that design to include session, command, event, and causation identity
   now rather than later.
3. Add schema names and versions before facts cross a process boundary.
4. Add runtime validation at ingress and durable/transport egress.
5. Separate attribution from authorization and define dispatch capability
   scopes.

### Gate 3: Introduce session ownership and cursor replay

1. Create a framework-independent session capability with dispatch, inspect,
   replay, and subscribe-from-cursor operations.
2. Give the session one global sequence across domain facts.
3. Make `@cab/router-solid` adapt an existing router/session capability instead
   of owning its runtime and journal lifetime.
4. Preserve history across provider remounts.
5. Define retention, snapshots, compaction, and subscriber overflow.
6. Reject duplicate adapter mounts or give each mount an independent token and
   disposer.

### Gate 4: Add mission-visible router capability

1. Add back, forward, and replace commands with explicit outcomes.
2. Add an imperative agent-facing router capability using the same session as
   Solid hooks.
3. Add expected-revision or precondition support for commands where stale state
   could cause harm.
4. Build a timeline/devtool that displays actor, command, outcome, sequence, and
   projection change. If the history is not understandable there, it will not
   be understandable to an agent.

### Gate 5: Add transport and collaboration policy

1. Add reconnectable transport using journal cursors.
2. Authenticate actor identity and authorize command capability.
3. Define duplicate command handling and idempotency.
4. Define optimistic concurrency, leases, or merge policy per domain.
5. Separate durable facts from ephemeral presence.
6. Test two agents and one human issuing overlapping commands against one
   session.

### Gate 6: Measure before broadening

1. Benchmark 100,000+ fact sessions and replay/catch-up.
2. Measure lagging subscriber memory and enforce a policy.
3. Measure many Solid subscribers, but optimize that bridge only if it is a
   demonstrated bottleneck.
4. Add unit tests to the mandatory repository close-out command.
5. Only then add conventional router features on top of the proven protocol.

## Highest-Value Missing Tests

1. Reducer defect during one-event and multi-event dispatch; assert no partial
   journal commit.
2. A journal observer that reads state on fact delivery; assert the documented
   consistency boundary.
3. Relative, query-only, hash-only, and absolute browser navigation; assert
   committed state equals canonical `history.current`.
4. Interrupted, defective, timed-out, and never-ending `history.push`; assert a
   terminal fact and continued router availability.
5. External navigation during delayed owned navigation; assert every human
   observation survives or an explicit loss fact is emitted.
6. Burst observations beyond buffer capacity.
7. `history.current` failure and history stream failure; assert diagnostics and
   recovery.
8. Browser popstate between initial read and listener readiness.
9. Gap-free retained-journal plus live-stream handoff from an arbitrary cursor.
10. Same `SolidRouter` in two providers, unmounted in both orders.
11. `onEvent` throws for one fact; assert later facts still arrive and the error
    is observable.
12. Navigation during component setup before observer readiness.
13. Captured navigate callback invoked after unmount; assert an observable
    rejection rather than a silent drop.
14. Journal and sequence continuity across Solid provider remount.
15. Public-entrypoint type tests for `@cab/router-solid`; its current TypeScript
    config checks source but not test contracts.
16. Plain-data serialization or schema round-trip for every fact variant.
17. Actor and command correlation across request, outcome, and external
    observation.
18. Long-session append, replay, compaction, and lagging-subscriber benchmarks.
19. Playground browser smoke without `RegistryProvider`, including push,
    popstate, event visibility, and failure feedback.

## Verification Performed

Fresh focused tests were run through the Nix development shell against the
reviewed working tree:

- `pnpm --filter=@cab/store run test:unit`: 25 tests passed.
- `pnpm --filter=@cab/router run test:unit`: 31 tests passed, including the type
  test.
- `pnpm --filter=@cab/router-solid run test:unit`: 16 tests passed.

Passing these tests confirms that the current implementation satisfies its
encoded contracts. It does not invalidate the findings above; several mission
gaps, especially observation coalescing and journal reset on remount, are current
tested behavior.

## Final Recommendation

Continue with this architecture, but rename the mental model:

- `@cab/store` is currently a useful local projection store with a journal, not
  yet the Cab session log.
- `@cab/router` is a good domain process manager and the best current proof that
  intent can become inspectable facts.
- `@cab/router-solid` should become a thin view adapter over a longer-lived
  session capability, not the owner of that capability.

The direction can meet the mission if the next work deepens the runtime around
session truth, command disposition, replay, and shared ownership. If the team
instead proceeds directly into route matching and UI conveniences while leaving
the current journal and lifecycle contracts intact, the architecture will
produce a competent router but not the human-agent collaboration substrate Cab
describes.
