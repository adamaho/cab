# monorepo

`monorepo` is a template repository for starting future projects with a shared
development environment and project structure.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow,
verification commands, workspace conventions, and commit guidelines.

## Prerequisites

Before developing in this repository, install:

- [Nix](https://nixos.org/download/)
- [Docker](https://docs.docker.com/get-docker/)

## Usage

Use this prompt with your coding agent to configure the template for a new
project:

```text
Configure this repository for a new project. Rename the project from `monorepo`
to the new project name, update package names, documentation, configuration
files, and references across the repo. Preserve the existing Nix and Docker
development setup unless a change is required for the new project.
```

## Development

This repo includes a Nix flake for the local development toolchain.
Run `nix develop` before working in this repository to enter the required
development shell.

```bash
nix develop
```

Start coding agents from inside the Nix development shell so their commands use
the same toolchain as local development.

```bash
nix develop
opencode
```

Agents should run verification commands from inside the Nix shell. If an agent
was not started from `nix develop`, run commands through `nix develop --command`
instead.
