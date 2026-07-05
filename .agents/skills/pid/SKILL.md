---
name: pid
description: >-
  Use a closed-loop control model based on PID controllers for coding work and
  coding-agent prompts. Apply this when an agent needs to implement, debug,
  review, or plan a code change by defining the setpoint, sensors, error
  signal, smallest corrective action, validation loop, and stability rules.
  Emphasize integral feedback from accumulated errors over time and derivative
  feedback from predicted future errors. Also use it when asked to draft a
  reusable prompt or workflow that makes another AI coding agent measure
  correctness before changing code. For UI-related changes in apps, libs, or
  features, use this with the pid-ui-sensors skill.
---

# PID

Turn coding work into a measured feedback loop. The goal is not a confident
patch; the goal is to reduce the error between desired behavior and current
behavior through small validated changes.

## Control Model

This skill is modeled after PID controllers. Use the control-system frame to
tune model output so measured error trends toward zero instead of relying on one
large open-loop generation.

Use these terms consistently:

- **Setpoint**: the observable behavior the change must produce.
- **Sensors**: the checks that measure whether the setpoint was reached.
- **Error signal**: the concrete gap between current and desired state.
- **Controller action**: the smallest code, test, prompt, or config change that
  reduces the error.
- **Stability rules**: constraints that prevent broad rewrites, unrelated
  changes, and oscillation.

### PID Terms

- **P / Proportional feedback**: correct the immediate measured error. Use the
  current compiler error, failing assertion, runtime exception, or observed
  behavior mismatch to choose the next patch.
- **I / Integral feedback**: account for accumulated error over time. Track
  repeated failure patterns, repo conventions, user preferences, and unresolved
  validation gaps so the agent stops reintroducing the same class of mistake.
- **D / Derivative feedback**: predict future error from the rate and direction
  of change. Before risky edits, identify likely failure modes introduced by the
  current patch trajectory, such as type drift, async races, public API changes,
  missing cleanup, user-facing regressions, or integration breakage.

The I and D terms are the important tuning tools for coding agents. Integral
feedback prevents recurring mistakes from surviving across turns. Derivative
feedback prevents overshoot by making the agent anticipate likely breakage
before it appears in validation.

### Normative Keywords

- Uppercase `MUST` = required
- Uppercase `MUST NOT` = prohibited
- Uppercase `SHOULD` = strongly recommended
- Uppercase `MAY` = optional
- Lowercase forms (`must`, `must not`, `should`, `may`) are explanatory and are
  not normative keywords.

## Workflow

Do these in order for implementation, debugging, and substantial code review
tasks. Keep each step proportional to the risk and size of the request.

### 1. Define The Setpoint

Before changing code, restate the desired outcome as observable acceptance
criteria.

Include the relevant parts only:

- user-visible behavior
- API behavior
- type behavior
- error and edge-case behavior
- performance, accessibility, or security requirements
- what MUST NOT change

If the user gave a vague target such as "fix this", "improve the UX", or "make
it cleaner", convert it into measurable behavior from the code, tests, bug
report, logs, screenshots, or reproduction steps by asking follow up questions for the information that is missing.

### 2. Identify The Sensors

Choose repo-native sensors before writing the patch. The standard repository
sensors are:

```bash
pnpm fmt
pnpm fmt:check
pnpm lint
pnpm tsc
pnpm turbo run test:unit
pnpm turbo run test:component
pnpm turbo run test:integration
```

For UI-related changes in `apps/*`, `libs/*`, or `features/*`, also load and
apply the `pid-ui-sensors` skill for UI-specific sensor selection. Do not
duplicate that sensor guidance here.

Use them this way:

- `pnpm fmt` MUST run before final validation when code, docs, config, or
  workflow files were edited. It writes formatting changes.
- `pnpm fmt:check` MUST run after formatting when the final state needs a
  read-only formatting signal.
- `pnpm lint` MUST run for completed code changes unless the change is
  documentation-only and outside linted files.
- `pnpm tsc` MUST run for completed TypeScript, package, config, or public API
  changes.
- `pnpm turbo run test:unit` MUST run when behavior, utilities, hooks,
  components, services, or tests changed and package unit tests exist.
- `pnpm turbo run test:component` SHOULD run when component tests exist and
  directly measure the setpoint.
- `pnpm turbo run test:integration` SHOULD run when service boundaries,
  database behavior, local infrastructure, API contracts, or cross-package
  integration changed. It MAY require local infrastructure from
  `@cab/infra-local`.

Focused sensors MAY be used during the loop to save time, such as
`pnpm --filter=<package> run test:unit`, `pnpm --filter=<package> run lint`, or
`pnpm turbo run test:unit --filter=<package>`. A focused sensor MUST be followed
by the relevant broader repository sensor before final completion unless the
agent explains why that broader command is unavailable or not applicable.

Manual sensors MUST be concrete. Use runtime logs, stack traces, network
requests, output artifacts, or manual diff review only when they directly
measure the setpoint. Manual diff review MUST check for unrelated edits, public
API drift, risky cleanup, and accidental changes to user work.

If an important behavior has no sensor, first make a suggestion to the user for one you think would be useful, then add a small test, assertion, or log only
when it is within scope. Do not create eval harnesses or broad benchmark files
unless the user explicitly asks for them.

### 3. Measure The Current Error

Inspect the current implementation before patching. Use concrete evidence:

- failing test names and assertions
- compiler or linter errors
- runtime exceptions and stack traces
- incorrect observable state or behavior
- mismatched request or response shape
- missing edge cases
- unexpected side effects

Do not guess when a sensor can produce the error signal. If a sensor is too
expensive to run immediately, explain the cheaper evidence being used and the
command that should close the loop later.

### 4. Choose The Smallest Corrective Action

Make the smallest change that reduces the measured error.

Prefer:

- local changes over broad rewrites
- existing patterns over new abstractions
- existing dependencies over new dependencies
- clear types over `any`
- focused tests over unrelated coverage expansion
- preserving public APIs unless the setpoint requires an API change

Do not refactor unrelated code. Do not rewrite tests to match broken behavior.
Do not widen the task because adjacent code looks imperfect.

### 5. Validate And Loop

Run the selected sensors after the patch. If validation fails, do not start
over and do not switch to a larger rewrite by default.

Instead:

1. Read the exact failure.
2. Identify the new error signal.
3. Explain the likely cause in task-local terms.
4. Apply the smallest corrective patch.
5. Re-run the relevant sensor.

Repeat until the measured error is zero or the remaining uncertainty is clearly
identified.

## Stability Rules

- Treat vague instructions as low signal, not permission for broad changes.
- Keep controller gain low: patch against the observed error, not every possible
  improvement.
- Use integral feedback deliberately. Repository rules, user preferences,
  repeated failure modes, and previous validation gaps SHOULD tune the next
  patch so accumulated error trends down. Stale or unrelated history MUST NOT
  dominate the current setpoint.
- Use derivative feedback before risky edits. The agent SHOULD predict future
  error from the rate and direction of the current change, name likely failure
  modes, and guard against them before touching code.
- Stop and ask only when the setpoint cannot be inferred and a reasonable
  assumption would be risky.
- Preserve user changes already present in the working tree.

## Prompt Drafting

When the user asks for a prompt instead of an implementation, produce a prompt
that makes the target agent run the same feedback loop.

Use this structure:

```text
You are helping me make a small, production-quality code change.

Goal:
<what I want>

Setpoint / acceptance criteria:
<observable behavior, API behavior, type behavior, edge cases, and what must
not change>

Context:
<relevant files, APIs, types, logs, screenshots, examples, or reproduction
steps>

Sensors:
<typecheck, focused tests, integration tests, logs, diff review, specialized
sensor skills, or other checks that prove correctness>

Constraints:
<no new dependencies, public API limits, strict types, existing patterns,
performance limits, accessibility requirements>

Workflow:
1. Restate the setpoint.
2. Identify likely failure modes.
3. Pick the smallest corrective action.
4. Make the patch.
5. Run the selected sensors.
6. If a sensor fails, patch only against that error signal and re-run it.

Do not:
- Rewrite unrelated files.
- Introduce new dependencies unless explicitly required.
- Use broad refactors as the first corrective action.
- Change public APIs unless the setpoint requires it.
```

## Final Report

When finishing coding work, report:

- the setpoint that was targeted
- the files changed and the function signatures in the file that changed
- the sensors run and their results
- any remaining risk, missing sensor, or validation that could not be run

Keep the report concise. The value is in measured proof, not a long narrative.
