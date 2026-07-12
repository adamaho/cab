import { Schema } from "effect";
import { Decision } from "../../runtime/decision.ts";
import { defineCommand, defineEvent } from "../../runtime/definition.ts";
import { defineFeature } from "../../runtime/feature.ts";

/** Names the supported interface themes. @category settings @since 0.0.0 */
export type Theme = "light" | "dark";

/** Is the settings feature's folded state. @category settings @since 0.0.0 */
export interface SettingsState {
  readonly theme: Theme;
  readonly pageSize: number;
}

const ThemeSchema = Schema.Union([Schema.Literal("light"), Schema.Literal("dark")]);

/** Records a semantic theme selection. @category settings-events @since 0.0.0 */
export const ThemeChanged = defineEvent({
  name: "ThemeChanged",
  version: 1,
  schema: Schema.Struct({ theme: ThemeSchema }),
  scope: "session",
  retention: "compactable",
  render: (args) => `changed theme to ${args.theme}`,
});

/** Records a committed todos page size. @category settings-events @since 0.0.0 */
export const PageSizeChanged = defineEvent({
  name: "PageSizeChanged",
  version: 1,
  schema: Schema.Struct({ size: Schema.Number }),
  scope: "session",
  retention: "compactable",
  render: (args) => `changed page size to ${args.size}`,
});

/** Requests a different interface theme. @category settings-commands @since 0.0.0 */
export const setTheme = defineCommand<
  "settings.setTheme",
  { readonly theme: Theme },
  SettingsState
>({
  name: "settings.setTheme",
  description: "Change the interface theme",
  args: Schema.Struct({ theme: ThemeSchema }),
  exposure: "public",
  decide: ({ state }, args) =>
    state.theme === args.theme
      ? Decision.noop("That theme is already active")
      : Decision.accept({ events: [ThemeChanged.make(args)] }),
});

/** Requests a bounded todos page size. @category settings-commands @since 0.0.0 */
export const setPageSize = defineCommand<
  "settings.setPageSize",
  { readonly size: number },
  SettingsState
>({
  name: "settings.setPageSize",
  description: "Change visible todo count",
  args: Schema.Struct({ size: Schema.Number }),
  exposure: "public",
  decide: ({ state }, args) =>
    args.size < 1 || args.size > 200 || !Number.isInteger(args.size)
      ? Decision.reject(
          "settings.page-size.out-of-range",
          "Page size must be an integer between 1 and 200",
        )
      : state.pageSize === args.size
        ? Decision.noop("That page size is already active")
        : Decision.accept({ events: [PageSizeChanged.make(args)] }),
});

/** Composes event-sourced interface settings. @category settings @since 0.0.0 */
export const settingsFeature = defineFeature<"settings", SettingsState>({
  name: "settings",
  initialState: { theme: "light", pageSize: 10 } satisfies SettingsState,
  events: [ThemeChanged, PageSizeChanged],
  commands: [setTheme, setPageSize],
  effects: [],
  reduce: (state: SettingsState, fact) => {
    if (fact.name === ThemeChanged.name) {
      return { ...state, theme: (fact.args as { readonly theme: Theme }).theme };
    }
    if (fact.name === PageSizeChanged.name) {
      return { ...state, pageSize: (fact.args as { readonly size: number }).size };
    }
    return state;
  },
});
