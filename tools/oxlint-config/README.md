# @cab/tool-oxlint-config

Shared Oxlint configuration for this Turborepo.

## Usage in a workspace package

1. Add this package to the workspace's `devDependencies`:

```json
{
  "devDependencies": {
    "@cab/tool-oxlint-config": "workspace:*"
  }
}
```

2. Create a `.oxlintrc.json` in that workspace:

```json
{
  "extends": ["../../tools/oxlint-config/src/base.json"]
}
```

`oxlint` currently expects a relative file path for `extends`. Point to `tools/oxlint-config/src/base.json` using the correct `../` depth for your workspace.

3. Add a lint script in that workspace:

```json
{
  "scripts": {
    "lint": "oxlint ."
  }
}
```

When the shared config changes, `turbo run lint` cache invalidation is handled by `^lint` in `turbo.json`.
