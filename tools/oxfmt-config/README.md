# @cab/tool-oxfmt-config

Shared Oxfmt configuration for this Turborepo.

## Usage in a workspace package

1. Add this package to the workspace's `devDependencies`:

```json
{
  "devDependencies": {
    "@cab/tool-oxfmt-config": "workspace:*"
  }
}
```

2. Reference the shared config from that workspace's format scripts:

```json
{
  "scripts": {
    "fmt": "oxfmt --config ../../tools/oxfmt-config/src/base.json .",
    "fmt:check": "oxfmt --check --config ../../tools/oxfmt-config/src/base.json ."
  }
}
```

Point to `tools/oxfmt-config/src/base.json` using the correct `../` depth for your
workspace.

Root format scripts reference this shared config path directly, so subsequent
format runs pick up changes here.
