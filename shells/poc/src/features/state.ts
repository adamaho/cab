import type { IngestState } from "./ingest/feature.ts";
import type { RouterState } from "./router/feature.ts";
import type { SettingsState } from "./settings/feature.ts";
import type { TodosState } from "./todos/feature.ts";

/** Is the state shape composed by the POC vertical features. @category state @since 0.0.0 */
export interface PocState {
  readonly router: RouterState;
  readonly settings: SettingsState;
  readonly todos: TodosState;
  readonly ingest: IngestState;
}
