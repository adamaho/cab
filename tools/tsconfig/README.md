# @cab/tool-tsconfig

Shared TypeScript configurations for this Turborepo.

## Exports

- `@cab/tool-tsconfig/base`: strict baseline compiler defaults.
- `@cab/tool-tsconfig/service`: NodeNext service defaults for backend workspaces.
- `@cab/tool-tsconfig/app-vite-react`: Vite app defaults for React workspaces.
- `@cab/tool-tsconfig/app-vite-solid`: Vite app defaults for Solid workspaces.

## Usage in a workspace package

1. Add this package to the workspace's `devDependencies`:

```json
{
  "devDependencies": {
    "@cab/tool-tsconfig": "workspace:*"
  }
}
```

2. Extend the workspace `tsconfig.json`:

```json
{
  "extends": "@cab/tool-tsconfig/service",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```
