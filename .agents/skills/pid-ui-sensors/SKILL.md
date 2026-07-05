---
name: pid-ui-sensors
description: >-
  Define and run UI-specific sensors for coding tasks that change visual
  appearance, layout, components, interaction states, accessibility, or browser
  behavior for any changes in the apps, libs or features folders. Use this with the pid skill when an agent needs to measure whether
  a UI change matches the desired output by combining source-of-truth artifacts,
  screenshots, DOM assertions, accessibility checks, browser console output,
  network observations, component tests, and repo validation commands.
---

# PID UI Sensors

Measure UI correctness with combined evidence. A screenshot alone is useful, but
it is rarely enough. Pair visual evidence with DOM, accessibility, runtime, and
test sensors so the agent can drive UI error toward zero without relying on
guesswork.

## Control Model

This skill is a UI-specific sensor pack for `pid`. Use it to define the
measurement system before a UI patch is made.

Use these terms consistently:

- **Source of truth**: the artifact or criteria that defines desired UI output.
- **Visual sensor**: screenshot, snapshot, or visual comparison evidence.
- **Semantic sensor**: DOM role, accessible name, state, focus, and keyboard
  behavior evidence.
- **Runtime sensor**: browser console, network, hydration, and interaction
  evidence.
- **Review artifact**: screenshot plus concise notes when no hard baseline
  exists.

### Normative Keywords

- Uppercase `MUST` = required
- Uppercase `MUST NOT` = prohibited
- Uppercase `SHOULD` = strongly recommended
- Uppercase `MAY` = optional
- Lowercase forms (`must`, `must not`, `should`, `may`) are explanatory and are
  not normative keywords.

## Source Of Truth

Classify the source of truth before choosing sensors.

### Hard Source Of Truth

Use this when there is a concrete artifact to compare against:

- Figma frame or design spec
- provided screenshot or mockup
- approved existing screenshot baseline
- Storybook story with known desired states
- explicit pixel, spacing, copy, color, breakpoint, or state requirements

When a hard source exists, screenshots SHOULD be compared against it. The agent
MUST state what changed, what matches, and what remains different.

### Soft Source Of Truth

Use this when correctness comes from existing product patterns:

- adjacent components in the same app
- design-system components already in the repo
- established button, form, modal, table, or navigation patterns
- acceptance criteria expressed in user-visible behavior

When only a soft source exists, screenshots MUST be used as review artifacts,
not as proof of exact visual correctness. The agent MUST cite the local pattern
it matched.

### Missing Source Of Truth

Use this when the user asks for a UI change without a visual reference,
acceptance criteria, or clear adjacent pattern.

The agent SHOULD ask for the missing source of truth when visual precision
matters. If the user wants progress without providing one, the agent MAY proceed
by creating review artifacts and clearly labeling the visual result as
agent-chosen rather than reference-matched.

## Sensor Stack

Use multiple sensors for UI work. The default stack is:

```bash
pnpm fmt
pnpm fmt:check
pnpm lint
pnpm tsc
pnpm turbo run test:unit
pnpm turbo run test:component
```

Before selecting browser-level sensors, determine what tooling can actually
produce the evidence. Inspect the repo and available tools before assuming
screenshots, browser automation, Storybook, or accessibility tooling exists.

Add browser-level sensors when the UI must be inspected in a running app:

- screenshot at the relevant viewport(s)
- DOM query for role, accessible name, text, state, and focus order
- keyboard interaction check for interactive elements
- browser console check for runtime, hydration, and accessibility warnings
- network check when the UI depends on API data or asset loading
- manual diff review for unrelated visual or behavior changes

`pnpm turbo run test:integration` SHOULD run when the UI behavior depends on
service boundaries, database state, local infrastructure, API contracts, or
cross-package integration. It MAY require local infrastructure from
`@router/infra-local`.

## Sensor Access And Tooling

The agent MUST establish how each selected UI sensor will be observed. A sensor
that cannot be run is a missing sensor, not a passing signal.

### Tooling Discovery

Start by looking for existing UI sensor tooling:

```bash
rg -n "playwright|puppeteer|cypress|storybook|chromatic|vitest|testing-library|axe" --glob package.json --glob '!node_modules/**' --glob '!repos/**'
find . -maxdepth 4 \( -iname '*playwright*' -o -iname '*storybook*' -o -iname '*cypress*' -o -iname '*vitest*' \) -not -path './node_modules/*' -not -path './repos/*'
```

Also inspect package scripts for app-specific commands:

```bash
find . -maxdepth 3 -name package.json -not -path './node_modules/*' -not -path './repos/*'
```

Use the strongest available path:

- Browser MCP or Playwright MCP, when available: use it to open the running app,
  capture screenshots, inspect DOM, check console output, and observe network
  requests.
- Existing Playwright, Cypress, or Puppeteer tests: add focused checks or run
  the narrowest existing browser test that covers the UI.
- Existing Storybook or component harness: render the component state there and
  capture screenshots or component-level assertions.
- Existing component/unit tests: use Testing Library-style role/name/state
  assertions when full browser automation is unavailable.
- Running app plus manual browser access: start the dev server, provide the URL,
  and ask the user for a screenshot only when the agent has no browser access.

### Missing Browser Tooling

If the repo has no screenshot or browser automation tooling, the agent MUST NOT
pretend screenshot validation happened. Instead, choose the best available
fallback and clearly label the gap.

Fallback order:

1. Use DOM/component tests for role, accessible name, state, and interaction.
2. Use static rendered output or Storybook if available.
3. Start the app locally and provide the exact URL for user inspection.
4. Ask the user for a reference screenshot or post-change screenshot when visual
   correctness cannot be measured otherwise.
5. Suggest adding lightweight browser tooling only when the task requires
   repeatable visual/browser validation.

Suggested tooling MUST be scoped to the sensor gap. For example:

- add Playwright when the repo needs repeatable screenshots, viewport checks,
  console checks, and network observation
- add Storybook when isolated component states are the missing source of truth
- add component tests when semantic behavior is missing coverage
- add axe or accessibility assertions when accessibility is the risky behavior

Do not add new tooling without user approval unless the task explicitly asks for
it. When proposing tooling, state the sensor it would unlock and the exact
failure mode it would reduce.

## UI Sensor Rules

- UI changes MUST define the viewport(s) to inspect. At minimum, inspect one
  desktop viewport. Responsive work MUST inspect mobile and desktop viewports.
- Component or interaction changes MUST inspect every meaningful state:
  default, hover or active where observable, focus, disabled, loading, error,
  empty, and success states as applicable.
- Button, link, input, menu, dialog, and form changes MUST include a semantic
  sensor for role, accessible name, disabled/expanded/selected state, and
  keyboard behavior where applicable.
- Layout changes MUST include screenshot evidence and MUST check for text
  clipping, overlap, unexpected overflow, layout shift, and broken responsive
  behavior.
- Visual changes SHOULD include before/after screenshots when modifying
  existing UI. New UI SHOULD include screenshots of the created state at the
  relevant viewport(s).
- Runtime browser checks MUST include console errors. Network checks MUST be
  included when correctness depends on fetched data, images, fonts, or API
  responses.
- The agent MUST NOT treat "looks okay" as a passing signal. State the exact
  visual, semantic, or runtime evidence that passed.

## Screenshot Sensors

Screenshots are mandatory when the user asks for visual UI work and a running UI
can be inspected.

Use screenshots to answer:

- Does the changed UI render?
- Does it match the hard source of truth, if one exists?
- Does it follow the soft source of truth, if that is all available?
- Are important states visible and distinguishable?
- Does text fit without clipping or overlapping?
- Does layout hold at the requested viewport(s)?

When a screenshot cannot be taken, the agent MUST say why and name the closest
available substitute, such as component tests, DOM assertions, rendered HTML, or
manual code review.

## DOM And Accessibility Sensors

Use DOM and accessibility checks to measure behavior that screenshots cannot
prove.

Interactive UI SHOULD be checked for:

- correct role, such as `button`, `link`, `textbox`, `dialog`, `menu`, or `tab`
- accessible name matching visible intent
- keyboard reachability and focus visibility
- disabled, expanded, pressed, selected, checked, and invalid states
- form labels, descriptions, errors, and submission behavior
- dialog focus trapping and escape/close behavior where applicable

Prefer explicit assertions over visual inference. For example, a primary button
change SHOULD verify both its screenshot appearance and its accessible button
name.

## Source-Of-Truth Gaps

If the desired visual result is underspecified, do not pretend the screenshot is
proof of correctness. Use this wording in the final report:

```text
Visual source of truth: none provided.
Sensor used: generated review screenshot at <viewport>.
Confidence: verifies render quality and obvious layout issues, not exact design
intent.
Needed to close the loop further: reference screenshot, Figma frame, or explicit
spacing/color/state requirements.
```

When the user provides a hard source later, use it as integral feedback: compare
the new artifact against the previous screenshot and the new source of truth,
then patch only the measured visual error.

## Final Report

When finishing UI work, report:

- the UI setpoint and source-of-truth tier
- the files changed and the components or routes affected
- the viewport(s), states, and browser/runtime sensors inspected
- the repo commands run and their results
- screenshot or review artifact locations, when created
- any missing source of truth or sensor that prevented stronger validation

Keep the report concise. The value is in evidence that the UI moved toward the
desired state.
