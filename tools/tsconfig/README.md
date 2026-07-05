# @monorepo/tool-tsconfig

Shared TypeScript configurations for this Turborepo.

## Exports

- `@monorepo/tool-tsconfig/base`: strict baseline compiler defaults.
- `@monorepo/tool-tsconfig/service`: NodeNext service defaults for backend workspaces.

## Usage in a workspace package

1. Add this package to the workspace's `devDependencies`:

```json
{
  "devDependencies": {
    "@monorepo/tool-tsconfig": "workspace:*"
  }
}
```

2. Extend the workspace `tsconfig.json`:

```json
{
  "extends": "@monorepo/tool-tsconfig/service",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```
