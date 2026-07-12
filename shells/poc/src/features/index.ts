/** Vertical todo ingest feature. @category features @since 0.0.0 */
export { ingestFeature } from "./ingest/feature.ts";
/** Vertical journal-derived router feature. @category features @since 0.0.0 */
export { routerFeature } from "./router/feature.ts";
/** Vertical event-sourced settings feature. @category features @since 0.0.0 */
export { settingsFeature } from "./settings/feature.ts";
/** Vertical todo interaction and presentation feature. @category features @since 0.0.0 */
export { todosFeature } from "./todos/feature.ts";

import { Context, Effect } from "effect";
import { createRuntime } from "../runtime/runtime.ts";
import { Viewport } from "../runtime/services.ts";
import { ingestFeature } from "./ingest/feature.ts";
import { routerFeature } from "./router/feature.ts";
import { settingsFeature } from "./settings/feature.ts";
import { todosFeature } from "./todos/feature.ts";

/** Is the canonical POC feature tuple for createRuntime. @category features @since 0.0.0 */
export const pocFeatures = [routerFeature, settingsFeature, todosFeature, ingestFeature] as const;

/** Constructs the canonical scoped POC runtime program. @category features @since 0.0.0 */
export function createPocRuntime(rendererId = "solid") {
  return Effect.gen(function* () {
    const viewport = yield* Viewport;
    return yield* createRuntime({
      features: pocFeatures,
      rendererId,
      replayContext: Context.make(Viewport, viewport),
    });
  });
}
