import { Schema } from "effect";
import { Decision } from "../../runtime/decision.ts";
import { defineCommand, defineEvent } from "../../runtime/definition.ts";
import { defineFeature } from "../../runtime/feature.ts";

/** Names the POC's journal-derived pages. @category router @since 0.0.0 */
export type Route = "todos" | "settings" | "about";

/** Is the router feature's folded state. @category router @since 0.0.0 */
export interface RouterState {
  readonly route: Route;
}

const RouteSchema = Schema.Union([
  Schema.Literal("todos"),
  Schema.Literal("settings"),
  Schema.Literal("about"),
]);

/** Records a semantic route transition. @category router-events @since 0.0.0 */
export const Navigated = defineEvent({
  name: "Navigated",
  version: 1,
  schema: Schema.Struct({ route: RouteSchema }),
  scope: "session",
  retention: "compactable",
  render: (args) => `navigated to ${args.route}`,
});

/** Requests a route transition through the public command surface. @category router-commands @since 0.0.0 */
export const navigate = defineCommand<"router.navigate", { readonly route: Route }, RouterState>({
  name: "router.navigate",
  description: "Open an application page",
  args: Schema.Struct({ route: RouteSchema }),
  exposure: "public",
  decide: (_context, args) => Decision.accept({ events: [Navigated.make(args)] }),
});

/** Composes journal-derived application routing. @category router @since 0.0.0 */
export const routerFeature = defineFeature<"router", RouterState>({
  name: "router",
  initialState: { route: "todos" } satisfies RouterState,
  events: [Navigated],
  commands: [navigate],
  effects: [],
  reduce: (state: RouterState, fact) =>
    fact.name === Navigated.name
      ? { route: (fact.args as { readonly route: Route }).route }
      : state,
});
