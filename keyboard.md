# `@cab/keyboard` — Modal Command Input Handoff

**Status: ready for implementation planning** · **Date:** 2026-07-11 ·
**Context:** Read `MISSION.md`, `CONTRIBUTING.md`, and the `pid` skill before
implementation.

## Purpose

Cab makes bespoke applications commandable by humans and agents through the same
semantic action language.

`@cab/keyboard` is the first small library supporting that mission. It should
make a graphical application feel like a coherent command environment in the
spirit of Neovim: modes and key sequences resolve to stable, named application
commands.

The keyboard is one input adapter. It must not become an independent behavior or
state mutation path.

```text
Mouse interaction ──────┐
Keyboard shortcut ──────┼─→ named command → validation → result
Command palette ────────┤
Agent tool call ────────┘
```

The first consumer will be Cab's Todo application. The library should remain
small enough to understand completely before it is reused elsewhere.

## Product Experience

The Todo application will support three familiar modes.

### Normal mode

Normal mode is for navigation and immediate actions.

| Key       | Intended Todo command          |
| --------- | ------------------------------ |
| `j`       | Focus next todo                |
| `k`       | Focus previous todo            |
| `g g`     | Focus first todo               |
| `G`       | Focus last todo                |
| `Enter`   | Open focused todo              |
| `x`       | Toggle focused todo completion |
| `a`       | Add a todo in Insert mode      |
| `e`       | Edit focused todo              |
| `v`       | Enter Visual mode              |
| `/`       | Search or filter               |
| `:`       | Open command palette           |
| `Space a` | Invoke agent with context      |
| `?`       | Show available keybindings     |
| `Escape`  | Close the active UI surface    |

The application should display the active mode and useful hints:

```text
NORMAL   Todo 4 of 18                     Press ? for commands
```

### Visual mode

Visual mode builds a structured selection of application objects.

| Key       | Intended Todo command          |
| --------- | ------------------------------ |
| `j`       | Extend selection downward      |
| `k`       | Extend selection upward        |
| `Space`   | Toggle the focused selection   |
| `g g`     | Extend to the first todo       |
| `G`       | Extend to the last todo        |
| `x`       | Toggle selected todos          |
| `Space a` | Invoke agent with selection    |
| `Escape`  | Clear selection; return Normal |

The application should make selection state obvious:

```text
VISUAL   4 todos selected                 Space a: Ask agent
```

Selections use stable domain IDs, never DOM positions.

### Insert mode

Insert mode is for ordinary text entry in forms, search, editing, and agent
prompts.

| Key           | Intended behavior                      |
| ------------- | -------------------------------------- |
| `Enter`       | Submit where the active surface allows |
| `Shift+Enter` | Insert a newline where supported       |
| `Escape`      | Cancel or return to the previous mode  |

Normal browser text editing must continue to work in Insert mode. Printable
keys such as `j`, `k`, `v`, and `x` must not invoke Normal-mode commands while a
person is typing.

## Agent Interaction

A representative flow is:

```text
j j        Focus the third todo
v          Enter Visual mode
j j j      Select four todos
Space a    Open the agent prompt with those todos attached
```

The application—not `@cab/keyboard`—turns the selection into structured context:

```json
{
  "screen": "todos",
  "sequence": 42,
  "selection": [
    { "kind": "todo", "id": "todo-3" },
    { "kind": "todo", "id": "todo-4" }
  ]
}
```

The agent surface shows those objects as context and preserves Cab's interaction
modes:

- **Ask:** inspect and explain, with no writes;
- **Propose:** prepare a reviewable command plan;
- **Do:** execute permitted routine commands immediately.

`Space a` should default to Propose for selected objects. The agent eventually
returns ordinary Todo commands. It never mutates selection or Todo state through
a special keyboard path.

## Command Categories

Being commandable does not mean every command belongs in the durable application
journal.

### Local interface commands

These are fast, ephemeral commands owned by the frontend:

```text
focusNextTodo
focusPreviousTodo
enterVisualMode
extendTodoSelectionNext
clearTodoSelection
openAgentPrompt
```

They do not need durable facts merely because a keyboard invoked them.

### Durable application commands

These change meaningful application state and flow through the application's
normal validation, API, and journal path:

```text
addTodo
renameTodo
setTodoCompletion
setTodoFilter
reorderTodos
```

### Agent orchestration commands

These manage delegation without directly changing Todo domain state:

```text
openAgentWithSelection
setAgentInteractionMode
submitAgentGoal
approveAgentPlan
cancelAgentRun
```

`@cab/keyboard` does not need to understand these categories. It only resolves a
key input to the named command configured by its consumer.

## Library Boundary

Create:

```text
libs/keyboard/
  package.json             @cab/keyboard
  src/
    index.ts                documented public exports
    types.ts                key step, binding, mode, and dispatch types
    normalize.ts            KeyboardEvent normalization
    resolver.ts             mode-aware sequence resolution
    controller.ts           event listener lifecycle and dispatch
  test/
    normalize.test.ts
    resolver.test.ts
    controller.test.ts
```

Follow actual repository package conventions discovered during implementation;
the filenames above describe responsibilities rather than a required internal
API.

### The library owns

- normalization of supported `KeyboardEvent` input;
- mode-specific keymap lookup;
- key chords and multi-step sequences;
- pending sequence state and timeout;
- exact-match versus valid-prefix resolution;
- dispatch of a named command and optional configured arguments;
- `preventDefault` only for a resolved Cab binding;
- repeat policy;
- attach/detach lifecycle;
- safe default handling for editable elements and IME composition;
- observable pending-sequence information needed for UI hints;
- startup validation for duplicate or impossible bindings.

### The application owns

- the meaning and implementation of commands;
- current application mode and mode transitions;
- focus cursor and Todo selection;
- command availability and rejection;
- durable journaling;
- agent context and invocation;
- rendering mode indicators and keybinding help;
- accessibility semantics of application components;
- user-customizable keymap persistence, if added later.

The library MUST NOT import Todo code, SolidJS, the Cab store, agent code, or a
journal implementation.

## Proposed Conceptual API

Do not treat this sketch as final without checking repository conventions and
writing type-level tests. It captures the intended boundary.

```ts
type KeyboardMode = string;
type KeyStep = string;

interface KeyBinding {
  readonly mode: KeyboardMode;
  readonly keys: readonly KeyStep[];
  readonly command: string;
  readonly args?: unknown;
  readonly allowRepeat?: boolean;
}

interface KeyboardCommandInvocation {
  readonly command: string;
  readonly args?: unknown;
  readonly mode: KeyboardMode;
  readonly keys: readonly KeyStep[];
  readonly source: "keyboard";
}

interface KeyboardControllerOptions {
  readonly bindings: readonly KeyBinding[];
  readonly getMode: () => KeyboardMode;
  readonly dispatch: (invocation: KeyboardCommandInvocation) => void;
  readonly sequenceTimeoutMs?: number;
}
```

A consumer should be able to define plain-data bindings:

```ts
const todoBindings = [
  { mode: "normal", keys: ["j"], command: "focusNextTodo" },
  { mode: "normal", keys: ["k"], command: "focusPreviousTodo" },
  { mode: "normal", keys: ["g", "g"], command: "focusFirstTodo" },
  { mode: "normal", keys: ["v"], command: "enterVisualMode" },
  { mode: "normal", keys: ["Space", "a"], command: "openAgentWithSelection" },
  { mode: "visual", keys: ["j"], command: "extendTodoSelectionNext" },
  { mode: "visual", keys: ["Escape"], command: "clearTodoSelection" },
] as const;
```

The exact syntax for chords such as `Mod+k` should remain intentionally small.
Do not build a keyboard grammar unless the initial Todo keymap proves one is
needed.

## Resolution Model

A resolver receives normalized key steps and the current mode.

```text
keydown
  → ignore unsafe or irrelevant event?
  → normalize key step
  → append to pending sequence
  → exact binding match? dispatch and clear
  → valid binding prefix? retain and show pending sequence
  → no match? clear and optionally retry current key as a new sequence
```

Examples:

```text
Normal + j
  → exact match: focusNextTodo

Normal + g
  → valid prefix: wait

Normal + g g
  → exact match: focusFirstTodo

Normal + g x
  → no match: clear sequence
```

Mode changes, focus leaving the controlled surface, explicit cancellation, and
timeout should clear the pending sequence.

Ambiguous maps where one binding is both an exact match and a prefix require an
explicit rule. The initial implementation SHOULD reject them during keymap
validation rather than introducing timing-dependent behavior.

## Browser Requirements

Keyboard handling is deceptively easy to get mostly right. The first
implementation must explicitly handle:

### Editable elements

Printable shortcuts must not run while the user is typing in:

- `input`;
- `textarea`;
- `select`;
- elements with `contenteditable`;
- elements inside an editable ancestor.

The consumer may intentionally enable a narrow set of global commands, such as
`Escape`, but this must be explicit.

### Input method editors

Ignore composition events:

```ts
if (event.isComposing) return;
```

Also account for browser composition key behavior where needed by measured
tests. Cab must not break non-Latin text entry.

### Key identity

Prefer `event.key` for printable Vim-style bindings because it represents the
character the user produced. Do not silently mix physical `event.code` semantics
into the initial API.

Normalize common names such as:

```text
" "      → "Space"
"Esc"    → "Escape"
```

Normalize `Meta` on macOS and `Control` elsewhere into `Mod` only for bindings
that explicitly use a platform command modifier.

### Default browser behavior

Call `preventDefault()` only after a complete Cab binding resolves and the
command will be dispatched. Unmatched keys and partial sequences should not
unnecessarily suppress browser behavior.

Some prefix keys, especially `Space`, may require a deliberate policy to prevent
scrolling while waiting for a sequence. Measure this in a running browser rather
than assuming unit tests prove it.

### Held keys

`event.repeat` should be disabled by default. Navigation commands may opt into
repeat. Destructive or agent commands must not repeat merely because a key is
held.

### Listener lifecycle

The controller must cleanly attach and detach from a supplied event target. It
must not install duplicate global listeners across component mounts or hot
reloads.

## Accessibility And Discoverability

Modal interfaces must explain themselves.

The Todo consumer should provide:

- a persistent visible mode indicator;
- visible selected-item count;
- a `?` help surface generated from active bindings;
- a pending-sequence hint such as `g…` or `Space…`;
- accessible announcements when mode changes;
- obvious keyboard focus styling;
- pointer-accessible controls invoking the same commands;
- a reliable `Escape` path back to Normal mode.

`@cab/keyboard` should expose enough binding and pending-sequence data for the
consumer to build these surfaces. It should not render them.

Modal keyboard support should not make pointer or assistive-technology use a
second-class path.

## Initial Setpoint

The first library version is complete when a Todo consumer can:

1. Attach one keyboard controller to an application surface.
2. Supply Normal, Visual, and Insert mode keymaps as plain data.
3. Resolve `j`, `k`, `g g`, `v`, `x`, `Escape`, and `Space a` to named commands.
4. Change a key's meaning based on the current mode.
5. Observe pending sequences for a visible key hint.
6. Type normally in Insert mode and editable elements.
7. Avoid dispatch during IME composition.
8. Opt navigation commands into held-key repeat while keeping other commands
   single-shot.
9. Remove all listeners and pending timers on cleanup.
10. Drive the same application command functions used by pointer controls.

## Non-goals For Version One

Do not add:

- Todo focus or selection logic;
- a SolidJS integration package;
- durable event sourcing or journaling;
- an agent runtime;
- a command registry implementation;
- user keymap persistence;
- arbitrary Vim command grammar;
- counts such as `12j`;
- macros or recording;
- text objects;
- operator-pending mode;
- recursive mappings;
- automatic conflict resolution;
- global operating-system shortcuts;
- support for every historical browser;
- a general gesture or input framework.

These features require concrete demand from the Todo application or later Cab
applications.

## PID Implementation Loop

### Setpoint

Implement the smallest framework-independent keyboard controller that maps
mode-aware key events and short sequences to named command invocations while
preserving ordinary browser text input and accessibility paths.

### Sensors

Before editing, inspect existing `libs/*` package, TypeScript, lint, test, and
public documentation conventions.

Focused sensors should include:

```bash
pnpm --filter=@cab/keyboard run tsc
pnpm --filter=@cab/keyboard run lint
pnpm --filter=@cab/keyboard run test:unit
```

Final repository sensors:

```bash
pnpm fmt
pnpm fmt:check
pnpm lint
pnpm tsc
pnpm turbo run test:unit
pnpm check
```

Browser behavior cannot be fully proved in a DOM shim. If the package or Todo
consumer has browser component tooling, add focused browser sensors for Space
scroll prevention, editable targets, focus changes, repeat, composition, and
listener cleanup. Otherwise, report that gap rather than treating unit tests as
browser proof.

### Required tests

At minimum, prove:

- `j` resolves to the Normal-mode command;
- the same `j` resolves to the Visual-mode command;
- `j` does not dispatch while typing in Insert mode;
- `g` is retained as a valid prefix;
- `g g` dispatches once and clears the sequence;
- `Space a` dispatches once;
- a wrong suffix clears the sequence;
- timeout clears a partial sequence;
- mode changes clear a partial sequence;
- unmatched keys do not request default prevention;
- exact matches request default prevention;
- composition does not dispatch;
- editable descendants do not dispatch printable commands;
- repeat is ignored unless the binding opts in;
- duplicate bindings are rejected;
- an exact binding that is also a prefix is rejected;
- controller cleanup removes listeners and timers;
- keyboard invocation contains the command, args, mode, key sequence, and
  `source: "keyboard"`.

### Likely derivative risks

Before implementation, guard against:

- swallowing browser keys that Cab did not handle;
- breaking text input, IME, or assistive technology;
- stale partial sequences surviving mode or focus changes;
- duplicate dispatch from key repeat or duplicate listeners;
- keymap conflicts becoming timing-dependent behavior;
- application logic leaking into the library;
- designing a large Vim emulator instead of the required command adapter;
- introducing a Solid dependency before a concrete integration requires it.

### Stability rules

- Keep the first API narrow and explicit.
- Prefer plain data and pure resolution logic.
- Keep DOM listener code separate from the pure resolver.
- Do not add an abstraction without a Todo acceptance case.
- Do not refactor unrelated packages while scaffolding the library.
- Public exports must follow repository JSDoc conventions.
- Stop when the initial setpoint passes; integrate with the Todo application in
  a separate deliverable.

## Handoff Summary

The implementation target is not “support keyboard shortcuts.” It is:

> Build a small, inspectable adapter that lets a Cab application map modal key
> sequences to the same named commands used by pointer controls and agents.

Normal, Visual, and Insert behavior belong to the Todo application. The library
provides reliable key normalization, mode-aware sequence resolution, lifecycle,
and dispatch. It does not own selection, Todo behavior, agent context, or the
journal.
