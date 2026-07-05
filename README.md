# router

`router` is a workspace for building router services, applications, shared
packages, and supporting tooling.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow,
verification commands, workspace conventions, and commit guidelines.

## Prerequisites

Before developing in this repository, install:

- [Nix](https://nixos.org/download/)
- [Docker](https://docs.docker.com/get-docker/)

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
