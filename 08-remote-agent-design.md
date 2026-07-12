# Cab Remote Agent Design — Browser-Authoritative Tool Loop

**Status: implementation-ready high-level design** · **Date:** 2026-07-11 · **Context:**
`07-poc-brief.md` (browser-local event-sourced POC), `06-store-design.md`
(command, screen, and journal architecture)

## Decision

Use a remote model for inference while keeping observation, command validation,
execution, attribution, and state changes inside the browser.

The model is a reasoning participant, not a trusted executor. It may propose a
command, receive its result, recover from a rejection, ask for clarification, or
finish. The browser remains the authority that decides whether a proposed action
can affect the application.

WebLLM is removed from the primary path. A local model may return later as an
optional inference provider, but it must use the same provider-neutral turn
contract and must not create a second command path.

## Setpoint

A user can describe a goal in the Cab devtools and a remote model can steer the
living application with little or no assistance.

Observable acceptance criteria:

1. The agent discovers the current screen, visible content, mode, journal
   sequence, and screen-relevant capabilities before acting.
2. The browser sends compact context to a server-side inference gateway. Model
   provider credentials never enter browser code, browser storage, logs, or the
   journal.
3. The model returns structured tool calls or a terminal response. Partial
   streamed JSON is never executed.
4. Every tool call executes through the existing browser MCP adapter and
   `store.dispatch`. There is no direct state mutation or alternate event path.
5. The browser binds a fixed `{ kind: "agent", id }` actor. The model cannot
   select or impersonate an actor.
6. Every accepted command produces the same attributed, ordered journal facts as
   a human or local caller. Rejected commands produce no facts.
7. A rejected, stale, or schema-invalid command is returned to the model with a
   structured reason and a fresh screen observation. The model can repair its
   action in the next turn.
8. The agent stops on completion, cancellation, a request for human input, an
   unrecoverable error, or configured turn/rejection limits.
9. The devtools show connection, reasoning, execution, rejection, recovery, and
   completion states without exposing hidden provider reasoning.
10. Theatre mode, replay, command validation, fetch effects, and human
    interaction continue to behave as they do today.

## Non-goals

- Giving the remote provider direct network access to the browser MCP surface.
- Letting the model append events or mutate folded state directly.
- Journaling model tokens, prompts, rejected commands, or private reasoning.
- Building provider-specific behavior into application components.
- Guaranteed offline inference.
- General computer-use automation outside Cab's registered commands.
- Treating arbitrary model text as executable code.

## Architecture

```text
┌──────────────────────── Browser ──────────────────────────┐
│                                                           │
│  Devtools goal                                             │
│       │                                                    │
│       ▼                                                    │
│  Agent controller ───── discoverScreen ─────┐              │
│       │                                      │              │
│       │ POST /v1/agent/turn                  │              │
│       ▼                                      │              │
└───────┼──────────────────────────────────────┼──────────────┘
        │                                      │
┌───────▼──────── Inference gateway ───────────┼──────────────┐
│  authenticate → redact/limit → provider adapter             │
│                              │                              │
│                              ▼                              │
│                         Remote model                        │
│                              │                              │
│                 streamed normalized response               │
└──────────────────────────────┼──────────────────────────────┘
                               │
┌──────────────── Browser ─────▼─────────────────────────────┐
│  Buffer and validate complete tool call                     │
│       │                                                    │
│       ▼                                                    │
│  BrowserMcp.call(name, args)                               │
│       │                                                    │
│       ▼                                                    │
│  schema → decide → facts → journal → fold → Solid UI       │
│       │                                                    │
│       └── result + fresh screen ──► next model turn        │
└────────────────────────────────────────────────────────────┘
```

### Boundary responsibilities

#### Browser agent controller

The controller owns the conversation and safety loop. It:

- captures the user's goal;
- calls `discoverScreen` before the first turn and after every attempted action;
- sends only the screen context, available tool schemas, goal, and bounded turn
  transcript needed for the next decision;
- buffers streamed provider output until a complete normalized response exists;
- checks that the tool is registered and available on the latest screen;
- invokes `BrowserMcp.call`;
- sends accepted or rejected results back to the model;
- enforces cancellation, time, turn, rejection, and repeated-action limits;
- renders a human-readable activity transcript.

The controller MUST NOT call `store.dispatch` directly. MCP remains its only
write boundary.

#### Browser MCP adapter

The adapter remains the mechanical bridge from tools to Cab:

- `discoverScreen` maps to the screen capability description;
- command tools map to registered Cab commands;
- JSON Schema remains the argument contract;
- the controller-provided actor is bound outside model-controlled arguments;
- successful calls return committed facts and the resulting sequence;
- rejections return structured errors without appending facts.

All registered commands remain introspectable. The controller only offers the
model capabilities relevant to the current screen. Runtime-owned commands may
remain registered for completeness but are not offered as model-selectable
screen capabilities.

#### Inference gateway

The gateway is a thin deployable service. It:

- owns provider credentials;
- authenticates and rate-limits browser requests;
- normalizes Cab turn requests into provider-specific tool-calling requests;
- normalizes provider streaming responses into Cab response events;
- applies request-size, output-size, and timeout limits;
- emits operational metrics without logging sensitive screen content by
  default.

The gateway does not connect to the store, execute tools, own the journal, or
persist application state.

#### Remote model

The model receives only the capabilities and state needed for the current turn.
It may return one of:

- one or more proposed tool calls;
- `complete` with a concise user-facing summary;
- `askUser` with a concise clarification question;
- `cannotComplete` with a reason.

Provider chain-of-thought is neither requested nor exposed. User-facing status
is based on observable lifecycle events and tool results.

## Turn protocol

### Request

`POST /v1/agent/turn`

```ts
interface AgentTurnRequest {
  readonly conversationId: string;
  readonly goal: string;
  readonly actorId: string;
  readonly turn: number;
  readonly screen: ScreenContext;
  readonly tools: readonly AgentToolDescription[];
  readonly transcript: readonly AgentTranscriptItem[];
}
```

The gateway is logically stateless. The browser sends a bounded normalized
transcript rather than relying on provider-specific conversation storage. This
keeps provider switching and retries explicit. A production implementation may
add encrypted server-side conversation storage later without changing the
browser contract.

### Streamed response

Use an HTTP streaming response such as server-sent events or newline-delimited
JSON. Normalize provider output into events:

```ts
type AgentResponseEvent =
  | { readonly type: "status"; readonly message: string }
  | { readonly type: "toolCallDelta"; readonly callId: string; readonly value: string }
  | { readonly type: "toolCall"; readonly call: ProposedToolCall }
  | { readonly type: "complete"; readonly summary: string }
  | { readonly type: "askUser"; readonly question: string }
  | { readonly type: "cannotComplete"; readonly reason: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };
```

`toolCallDelta` events are display/transport artifacts only. The browser MUST
NOT execute them. Only a complete `toolCall` that passes local structural and
capability checks may reach MCP.

### Tool result

```ts
interface AgentToolResult {
  readonly callId: string;
  readonly command: string;
  readonly args: unknown;
  readonly outcome:
    | {
        readonly ok: true;
        readonly committedSequence: number;
        readonly facts: readonly Fact[];
      }
    | {
        readonly ok: false;
        readonly code:
          | "INVALID_ARGUMENTS"
          | "UNAVAILABLE_COMMAND"
          | "COMMAND_REJECTED"
          | "STALE_SCREEN"
          | "EXECUTION_ERROR";
        readonly message: string;
      };
  readonly screenAfter: ScreenContext;
}
```

The result is appended to the bounded agent transcript, not the event journal.
Accepted commands already describe themselves through committed facts. Rejected
commands remain observable in devtools without violating the invariant that a
rejection appends no events.

## Conversation and recovery loop

```text
1. Observe current screen and sequence.
2. Send goal, available tools, observation, and bounded transcript.
3. Buffer and validate the normalized model response.
4. For each proposed tool call:
   a. Confirm the viewed sequence is still current.
   b. Confirm the tool is available on the current screen.
   c. Execute through BrowserMcp.call.
   d. Observe the screen again.
   e. Record the tool result in the agent transcript.
   f. Stop the batch if a command is rejected or capabilities changed.
5. If complete, stop successfully.
6. If rejected or stale, send the result and fresh screen in the next turn.
7. If askUser, pause without dispatching anything.
8. Stop when a stability limit is reached.
```

A model may propose a short batch to reduce latency. The browser executes the
batch sequentially and revalidates before each command. It never assumes the
rest of a plan is valid after state changes.

### Example recovery

```text
User goal: Toggle the first incomplete todo

Model       → filterTodos({ filter: "incomplete" })
Browser     → accepted, fact #12, fresh screen
Model       → toggleTodo({ id: 14, completed: true })
Browser     → rejected: Todo 14 is on page 2, fresh screen
Model       → setTodoPage({ page: 2 })
Browser     → accepted, fact #13, fresh screen
Model       → toggleTodo({ id: 14, completed: true })
Browser     → accepted, fact #14, fresh screen
Model       → complete
```

## Journal semantics

The journal contract does not change.

```text
Model proposal
  ≠ fact

Accepted MCP command
  → decide
  → event envelope with bound agent actor
  → append to journal
  → fold

Rejected MCP command
  → transcript result only
  → no fact
```

The model cannot provide `sequence`, `actor`, `at`, event names, or event
payloads. These remain browser/store responsibilities.

Async effects keep their originating actor. For example, an agent's
`refreshTodos` command produces `RefreshRequested` as that agent, and the
runtime-generated completion or failure retains the requesting actor according
to the existing effect runner contract.

## Concurrency and stale state

Humans remain free to use the application while the model is thinking. Every
model turn therefore includes the observed journal sequence.

Before executing a proposed call, the controller compares that sequence with
the live sequence:

- If unchanged, execution may proceed.
- If changed but the command remains clearly valid, the controller still
  re-observes and asks the model to confirm rather than guessing.
- If the app is in theatre/history mode, commands are rejected locally and the
  agent pauses until Live mode is restored.

This favors correctness over silently applying a plan to a screen the model did
not observe.

## Safety and stability rules

Initial POC limits:

- maximum 12 model turns per run;
- maximum 3 consecutive rejected calls;
- maximum 3 repetitions of the same command and arguments;
- maximum 4 commands in one proposed batch;
- configurable request and generation timeout;
- one active run per browser store;
- user cancellation available during network and execution phases;
- stop the current batch after any rejection or stale-screen signal;
- no automatic retry of commands later classified as destructive;
- provider errors never fall through to direct execution.

The controller should prefer a readable terminal failure over an unbounded
repair loop.

## Security and privacy

- Provider API keys MUST remain server-side.
- The gateway MUST authenticate callers and enforce rate and size limits.
- The browser MUST treat model output as untrusted input.
- Tool names and arguments MUST be validated locally even if the provider
  claims structured-output compliance.
- The model MUST NOT control actor identity or event metadata.
- Send screen context, not DOM dumps, screenshots, full journals, cache payloads,
  secrets, or unrelated browser state.
- Gateway logs SHOULD contain request IDs, timing, provider/model identifiers,
  token counts, and error codes, but not goals or screen payloads by default.
- The UI MUST state that goal and screen context are sent to a remote provider.
- Provider retention and data-processing policy MUST be documented before a
  production rollout.

## User experience

The Local agent tab becomes an Agent tab with observable states:

```text
Idle
Connecting to inference service…
Model is reading the Todos screen…
Proposed filterTodos({ filter: "incomplete" })
Committed event #12
Command rejected: Todo 14 is on page 2
Model is revising the plan…
Completed: toggled the first incomplete todo
```

The transcript shows proposed commands, accepted sequences, rejection reasons,
and user-facing model messages. It does not show hidden chain-of-thought or raw
provider payloads.

`Stop` aborts the active HTTP stream and prevents any not-yet-started command
from executing. A command already inside synchronous `store.dispatch` completes
atomically.

## Package direction

POC implementation:

```text
shells/poc/src/agent/
  controller.ts          browser-owned conversation and safety loop
  protocol.ts            provider-neutral request, stream, and result types
  remote-client.ts       HTTP streaming client
  browser-mcp.ts         existing local execution adapter

services/agent-gateway/
  src/server.ts           HTTP endpoint, auth/rate/timeout boundary
  src/provider.ts         normalized provider interface
  src/providers/<name>.ts provider-specific mapping
```

The shell should only compose the controller into devtools. Reusable protocol,
controller, and gateway code can move into production libraries after the POC
proves the contract.

## Implementation deliverables

### Deliverable 1 — Protocol and fake gateway loop

Setpoint:

- Define the normalized turn protocol.
- Replace the WebLLM-specific controller dependency with an injected remote
  client.
- Use a deterministic fake gateway in tests.
- Execute proposed calls through the existing browser MCP adapter.
- Show accepted and rejected calls in the agent transcript.

This proves the browser-authoritative loop without provider or network
uncertainty.

### Deliverable 2 — Inference gateway and one provider

Setpoint:

- Add the server-side gateway.
- Integrate one fast tool-capable model behind the provider interface.
- Keep credentials server-side.
- Normalize streaming provider output.
- Add timeout, cancellation, rate limit, and redacted operational logs.

Provider and model selection should happen at implementation time using measured
latency, structured tool accuracy, price, and retention policy rather than being
hard-coded in this design.

### Deliverable 3 — Recovery and concurrency

Setpoint:

- Return structured command rejections and fresh observations to the model.
- Detect human journal changes between observation and execution.
- Enforce turn, repetition, rejection, and batch limits.
- Support `askUser`, cancellation, and readable terminal failures.

### Deliverable 4 — Remove primary WebLLM path

Setpoint:

- Remove the WebLLM dependency and worker from the default bundle after the
  remote path passes mission-level sensors.
- Preserve a provider interface capable of accepting a future local backend.
- Verify that browser startup no longer downloads or bundles local inference
  code.

## PID implementation plan

### Sensors

Repo sensors:

```bash
pnpm fmt
pnpm fmt:check
pnpm lint
pnpm tsc
pnpm turbo run test:unit
pnpm turbo run test:component
pnpm turbo run test:integration
pnpm check
```

Focused behavioral sensors:

- controller unit tests with deterministic streamed model events;
- MCP tests proving accepted calls are attributed and journaled;
- rejection tests proving no facts are appended;
- stale-sequence tests with a human event inserted while a turn is pending;
- malformed and partial tool-call tests proving nothing executes;
- cancellation tests before response, during stream, and between batch calls;
- gateway contract tests with a fake provider;
- integration test covering gateway → controller → MCP → journal → fresh screen;
- component tests for status, transcript, ask-user, rejection, retry, and stop
  states;
- network inspection proving provider credentials never reach the browser;
- browser console checks for stream, CORS, and runtime errors.

Mission-level sensor:

```text
Load todos → ask the agent to show incomplete todos and use dark mode → observe
remote status → verify filter and navigation/theme facts are attributed to the
agent → introduce a recoverable rejected command → verify the model receives the
reason and repairs it → scrub before the run → verify the complete interface
rewinds → return Live.
```

Latency sensors should record, separately:

- gateway connection time;
- time to first normalized response event;
- time to first complete tool call;
- command dispatch-to-commit time;
- total goal completion time;
- additional turns caused by rejection or stale state.

Set an explicit latency budget when selecting the first provider. Do not call the
experience instantaneous without measurements from the intended deployment and
client network.

### Error signals

Implementation should patch against concrete signals:

- invalid streamed event shape;
- partial output reaching execution;
- unknown or unavailable command reaching the store;
- rejected command appending a fact;
- incorrect actor attribution;
- stale model action executing after a human change;
- provider key visible in browser assets or requests;
- cancellation followed by a later dispatch;
- repeated repair loops;
- latency exceeding the selected budget.

### Controller actions

Use the smallest correction for each measured error:

- protocol decoder before controller rewrites;
- local capability check before broader prompt changes;
- bounded transcript compaction before adding server state;
- one provider adapter before a provider framework;
- focused retry for transport errors, not automatic command retries;
- fresh observation after rejection, not speculative argument repair in the
  browser.

### Stability rules

- Preserve the current store, fold, command, screen, runtime, and journal APIs
  unless a failing sensor proves a required contract gap.
- Do not combine gateway, provider, recovery, and UI implementation into one
  patch.
- Do not weaken schemas to accept provider output.
- Do not journal rejected attempts to simplify transcript implementation.
- Do not expose provider SDK types outside the gateway adapter.
- Do not add persistence, multiplayer sync, or production identity work to this
  slice.
- Stop each deliverable when its setpoint and sensors pass before beginning the
  next.

## Open implementation decisions

Resolve these with measured prototypes during Deliverable 2:

1. Which provider/model has the best structured-tool accuracy at the required
   latency and cost?
2. SSE or newline-delimited JSON for the normalized stream?
3. Authentication mechanism for the POC gateway in local and shared dev?
4. Exact latency budget and timeout for the target deployment?
5. Whether the provider can reliably produce short command batches or should be
   restricted to one tool call per turn?
6. Which commands, if any, need an explicit destructive-action classification
   before production use?

These choices must not change the core invariant: the remote model reasons, the
browser decides and executes, and the journal remains the source of truth.
