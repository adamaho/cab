# Cab Mission

Cab makes bespoke user interfaces shared workspaces for humans and agents.

The goal is not to replace applications with chat or generated interfaces. It is
to preserve the clarity, craft, predictability, and shared visual language of a
purpose-built application while allowing humans and agents to observe and
operate it through the same precise actions.

An agent should not guess at pixels or rewrite application data from outside the
interface. It should join the application as a participant: understand what is
on screen, discover what actions are available, invoke those actions, receive
clear acceptance or rejection, and leave attributed history behind.

## Product Bet

We believe humans will continue to need interfaces.

People use interfaces for more than issuing instructions. Interfaces help us
understand state, notice changes, compare options, build muscle memory, and
coordinate with other people. A bespoke application gives humans and agents a
stable place to work together.

Generated interfaces can be useful as temporary lenses for an unexpected
question or explanation. They should not replace the durable workspace or
invent new authority.

```text
Bespoke application = durable workspace
Generated view       = temporary lens
Human or agent       = participant
Commands             = shared action language
Journal              = shared memory
```

Cab's bet is that the future is not agents replacing applications. It is
carefully designed applications becoming agent-native: flexible about who can
operate them, how work is delegated, and how every consequential action can be
understood and recovered.

## Interaction Modes

Cab applications should make the amount of delegated authority explicit.

### Ask

The agent may inspect the application and explain what it finds, but it may not
change application state.

```text
“Which todos are blocking the release?”
```

Ask is useful for questions, summaries, comparisons, and explanations.

### Propose

The agent prepares a concrete, reviewable command plan. The human can approve,
edit, or cancel it before execution.

```text
I’ll make these changes:

1. Mark “Update documentation” complete
2. Move “Release package” to Today
3. Add “Notify customers”

[Approve] [Edit] [Cancel]
```

Propose should be the default for consequential, ambiguous, broad, or unfamiliar
work.

### Do

The agent may execute commands immediately within the authority the human has
granted.

```text
“Show incomplete todos.”
```

Do is useful for routine, reversible, well-understood actions. Every accepted
action remains attributed and observable.

These modes use the same observation and command system. They differ only in
which commands may be dispatched and whether human approval is required first.

## Invoking The Agent

Chat should not be the only way to work with an agent. Cab should support several
entry points into the same agent runtime.

### Global invocation

A keyboard shortcut opens an agent command bar. The application supplies the
current screen, visible content, selection, available commands, permissions, and
journal position as structured context.

```text
⌘K → “Show my incomplete todos and prioritize anything overdue.”
```

### Contextual invocation

A human selects an application object and asks the agent to work with that
specific context.

```text
Select three todos → Ask Cab → “Move these to next week.”
```

### Application affordances

Bespoke components may expose deliberate delegation points where the application
author knows agent assistance is useful.

```text
Todo list  [Add todo] [Ask agent to organize]
```

### Proactive suggestions

An agent may eventually notice useful work, but it should propose the action
before executing until the human grants broader authority.

```text
“Five completed todos are still in Today. Archive them?”
```

Voice, accessibility input, and future interaction methods should feed the same
goal and command system rather than create separate application architectures.

## Commandable Interfaces

A Cab interface should behave like a well-designed command environment.

Neovim is a useful analogy: a keyboard mapping is not the behavior itself. It is
one way to invoke a stable, named command. Cab applies that separation to a
bespoke graphical interface.

```text
Mouse interaction ──────┐
Keyboard shortcut ──────┼─→ named command → validation → result
Agent tool call ────────┘
```

A checkbox click, keyboard shortcut, command palette entry, and agent tool should
all invoke the same semantic command. The component is an input adapter, not an
independent write path.

Commands should be:

- named in the application's domain language;
- described in plain language;
- typed and schema-validated;
- discoverable with their current availability;
- accepted or rejected with a readable reason;
- attributable to the human or agent that invoked them;
- independent of the mouse, keyboard, voice, or agent entry point.

This does not mean recording every DOM event. Cab captures semantic commitments,
not mechanical gestures.

```text
Open a dropdown          → temporary local interaction
Choose “Incomplete”      → setTodoFilter command

Type into a form         → temporary local draft
Submit “Buy milk”        → addTodo command

Hover a row              → temporary local interaction
Toggle its checkbox      → setTodoCompletion command
```

Focus, hover, pointer movement, animation progress, and uncommitted form input
remain ordinary local UI state unless a concrete collaboration need proves
otherwise.

## History And Replay

Every accepted semantic action should leave enough attributed history to answer:

- What changed?
- Who or what changed it?
- What did the application show before and after?
- Was the action accepted, rejected, or interrupted?
- Can a human inspect or recover from an agent run?

Cab aims for semantic application replay, not pixel-perfect recording. The
journal captures meaningful state transitions. Materialized views and periodic
snapshots can act like keyframes in a video buffer, allowing current and
historical application views to be reconstructed efficiently.

Theatre mode is one expression of this capability. The deeper product value is
review, comparison, recovery, debugging, and trust in delegated work.

## Local-First Intelligence

Cab assumes that capable local agents will increasingly run on the user's
device. AI inference should be treated as a replaceable source of reasoning, not
as the authority over application state.

The user's device is the natural home for:

- rendering the interface;
- gathering structured screen context;
- running or coordinating the agent;
- preparing and reviewing proposed commands;
- maintaining responsive local interaction state.

Servers may provide identity, authorization, durable data, command acceptance,
ordering, synchronization, and temporary remote inference when local hardware is
not yet sufficient.

Switching between local and remote reasoning must not change the application's
commands, authority rules, history, or user interaction model. The reasoner
proposes; the application decides and records.

## Architecture Principles

1. **Bespoke before general-purpose.** Build concrete applications and learn
   from them. Prefer three real examples before extracting a shared abstraction.
2. **Commands are the write language.** Humans, shortcuts, components, scripts,
   and agents use the same semantic actions.
3. **The application remains authoritative.** A model cannot invent facts,
   actors, permissions, or state transitions.
4. **Accepted actions become attributed history.** Rejections are observable but
   do not pretend a state change occurred.
5. **Rendering and authority are separate.** The browser owns presentation and
   ephemeral interaction; application rules own meaningful transitions.
6. **Structured observation beats pixel guessing.** Agents receive intentional
   descriptions of screens, content, selection, and capabilities.
7. **Generated UI is a lens, not authority.** Temporary views may explain or
   reorganize information but act through registered commands.
8. **Safety is visible.** Ask, Propose, and Do make delegated authority clear to
   the human.
9. **History serves understanding.** Replay exists to review, recover, compare,
   and build trust—not merely as a technical demonstration.
10. **Reasoning providers are replaceable.** Local and remote models connect to
    the same constrained observation and command boundary.

## First Concrete Application

Cab begins with a Todo application.

The first implementation should use a traditional Todo API and a frontend where
every meaningful interaction is a command. The frontend journal demonstrates
that mouse, keyboard, command palette, and agent invocation can share one action
language before Cab attempts a general abstraction.

Initial command examples:

```text
addTodo
renameTodo
setTodoCompletion
setTodoFilter
selectTodo
```

Initial input paths:

```text
Visible controls
Keyboard shortcuts
Command palette
Scripted agent
```

The remote or local language model is not the foundation. It is a later way to
choose commands after the commandable interface works deterministically.

## What Cab Is Not

Cab is not:

- a general-purpose state-management library;
- a generic sync engine;
- a replacement for bespoke application design;
- a DOM-recording or computer-use system built around screenshots;
- a model with unchecked access to application storage;
- a requirement that every hover, click, or keystroke become durable state;
- an attempt to solve every application kind before building concrete ones.

Cab should become an architecture we understand and enjoy using because it
supports the specific collaboration features we care about. Generality must be
earned from repeated applications rather than assumed in advance.
