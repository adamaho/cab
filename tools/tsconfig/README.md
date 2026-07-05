# @router/tool-tsconfig

Shared TypeScript configurations for this Turborepo.

## Exports

- `@router/tool-tsconfig/base`: strict baseline compiler defaults.
- `@router/tool-tsconfig/service`: NodeNext service defaults for backend workspaces.

## Usage in a workspace package

1. Add this package to the workspace's `devDependencies`:

```json
{
  "devDependencies": {
    "@router/tool-tsconfig": "workspace:*"
  }
}
```

2. Extend the workspace `tsconfig.json`:

```json
{
  "extends": "@router/tool-tsconfig/service",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```
