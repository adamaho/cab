# Contributing

This repository is a template monorepo. Keep changes small, explicit, and easy
to carry forward into future projects created from the template.

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
pnpm --filter=@monorepo/infra-local run infra:up
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
for example `@monorepo/shell-web`, `@monorepo/feature-billing`,
`@monorepo/service-api`, or `@monorepo/lib-dates`.

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
root-only template changes, use `monorepo`.

Examples:

```text
chore(monorepo): add contributor documentation
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
