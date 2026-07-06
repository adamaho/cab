# Contributing

This repository contains the cab workspace. Keep changes small, explicit,
and easy to review.

## Prerequisites

Install these before working in the repo:

- [Nix](https://nixos.org/download/)
- [Docker](https://docs.docker.com/get-docker/)

## Development Setup

Enter the Nix development shell before running project commands:

```bash
nix develop
```

Install dependencies:

```bash
pnpm install
```

Start local infrastructure when a package needs shared runtime services:

```bash
pnpm --filter=@cab/infra-local run infra:up
```

## Verification

Run the full local verification command before opening a PR or committing a
completed change:

```bash
pnpm check
```

This runs the repository format check first, then lets Turbo run package-level
lint and TypeScript tasks in parallel where packages define them.

Useful focused commands:

- `pnpm fmt` formats the repository
- `pnpm fmt:check` checks formatting without writing changes
- `pnpm lint` runs package lint tasks through Turbo
- `pnpm test:unit` runs package unit test tasks through Turbo
- `pnpm tsc` runs package TypeScript tasks through Turbo

## Workspace Layout

Use the existing top-level workspace directories consistently:

- `shells/*` for deployable application hosts that compose product features
- `services/*` for deployable backend services and workers
- `features/*` for vertical product features shared across shells or services
- `libs/*` for reusable libraries
- `clients/*` for generated or hand-written external service api clients
- `tools/*` for internal tooling packages
- `infra/*` for local and shared infrastructure helpers

Shell packages should stay thin. Use them for routing, layouts, providers,
runtime wiring, deploy configuration, and feature composition. Put product
behavior in `features/*`, and move reusable primitives that are not tied to a
feature into `libs/*`.

Package names should use the repository npm scope and a clear package suffix,
for example `@cab/shell-web`, `@cab/feature-billing`,
`@cab/service-api`, or `@cab/lib-dates`.

## Code Organization

Use simple fence comments to divide larger source files into logical sections
when it improves scanning. Prefer short section names such as `State`,
`Component`, `Styles`, `Helpers`, or `Types`, and keep file-local styles near
the bottom of the file unless an existing pattern says otherwise.

## Code Documentation

Document public exports with Effect-style JSDoc. Public exports include types,
interfaces, classes, services, functions, layers, atoms, constants, and tagged
enum constructor bundles that are re-exported from a package entrypoint.

Use this shape for public APIs:

```ts
/**
 * One-sentence summary in plain language.
 *
 * **When to use**
 *
 * Explain when callers should reach for this API when that is not obvious from
 * the name.
 *
 * **Details**
 *
 * Document important semantics, invariants, failure behavior, and lifecycle
 * rules.
 *
 * @see {@link relatedApi} for related behavior
 * @category category-name
 * @since 0.0.0
 */
export function publicApi() {}
```

Rules:

- Keep the opening summary short and useful in generated API docs.
- Add `**When to use**`, `**Details**`, `**Example**`, `**Gotchas**`, or `@see`
  only when they add information a caller needs.
- Include `@category` for public package APIs so generated docs group related
  exports consistently.
- Include `@since` on public package APIs. Use the package version where the API
  first appears; for initial private packages, use `@since 0.0.0`.
- Prefer documenting observable behavior and invariants over implementation
  details.
- Do not add noisy JSDoc to file-local helpers unless the helper is subtle and a
  short comment would prevent misuse.

## Dependency Management

Prefer centralizing shared dependency versions in `pnpm-workspace.yaml` using
the catalog. This keeps package manifests small and makes upgrades easier to
review.

Use exact versions. The root `.npmrc` sets `save-exact=true` and
`engine-strict=true`.

## Commit Messages

Prefer using the configured coding agent commit workflow when creating commits.
The agent formats the repo, stages the intended changes, writes a compliant
commit message, and pushes to the current branch.

Commit subjects must use scoped Conventional Commit format:

```text
<type>(<scope>): <description>
```

Allowed types:

- `feat`
- `fix`
- `docs`
- `chore`
- `refactor`
- `test`

Use the affected package name without the npm scope as the commit scope. For
root-only repository changes, use `cab`.

Examples:

```text
chore(cab): add contributor documentation
feat(shell-web): add account settings page
fix(service-api): validate missing request body
```

## Coding Agents

Start coding agents from inside the Nix shell so their commands use the same
toolchain as local development:

```bash
nix develop
opencode
```

If an agent was not started inside `nix develop`, run verification commands
through Nix explicitly:

```bash
nix develop --command pnpm check
```

Agent instructions live in `AGENTS.md`. Keep `CLAUDE.md` symlinked to
`AGENTS.md` so `AGENTS.md` remains the source of truth for agent behavior.

Agents should load and apply the `pid` skill before implementation, debugging,
review, refactoring, scaffolding, package config, dependency, TypeScript, and
test changes. Skip `pid` only for purely conversational answers, git-only commit
or push tasks, or one-off shell queries that do not affect code correctness.
