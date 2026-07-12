import { Effect, Layer } from "effect";
import { JournalMemoryLive } from "./journal.ts";
import {
  IdGeneratorLive,
  RenderCoordinatorLive,
  RuntimeClockLive,
  RuntimeSupervisorLive,
  TargetNotMounted,
  TodoApi,
  TodoApiError,
  Viewport,
  makeTodoCacheLayers,
  type TodoRecord,
} from "./services.ts";

function decodeTodos(value: unknown): readonly TodoRecord[] {
  if (!Array.isArray(value)) throw new Error("Todo API returned a non-array payload");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { id?: unknown }).id !== "number" ||
      typeof (item as { title?: unknown }).title !== "string" ||
      typeof (item as { completed?: unknown }).completed !== "boolean"
    ) {
      throw new Error("Todo API returned an invalid todo");
    }
    const todo = item as TodoRecord;
    return { id: todo.id, title: todo.title, completed: todo.completed };
  });
}

/** Uses browser fetch only behind the TodoApi service boundary. @category browser-layers @since 0.0.0 */
export const TodoApiBrowserLive = Layer.succeed(TodoApi, {
  list: () =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch("https://jsonplaceholder.typicode.com/todos", { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return decodeTodos(await response.json());
      },
      catch: (cause) =>
        new TodoApiError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
});

/** Uses browser document only behind the semantic Viewport service boundary. @category browser-layers @since 0.0.0 */
export const ViewportBrowserLive = Layer.succeed(Viewport, {
  scrollTo: (anchor, options) =>
    Effect.sync(() => {
      const target = document.querySelector(anchor);
      if (!target || typeof target.scrollIntoView !== "function") {
        throw new TargetNotMounted({ anchor });
      }
      target.scrollIntoView({ behavior: options.behavior, block: options.block });
    }).pipe(
      Effect.catchDefect((cause) =>
        Effect.fail(cause instanceof TargetNotMounted ? cause : new TargetNotMounted({ anchor })),
      ),
    ),
});

/** Supplies all core POC browser and memory adapters except the Journal layer. @category browser-layers @since 0.0.0 */
export function makeBrowserRuntimeLayers() {
  return Layer.mergeAll(
    TodoApiBrowserLive,
    ViewportBrowserLive,
    makeTodoCacheLayers(),
    IdGeneratorLive,
    RuntimeClockLive,
    RenderCoordinatorLive,
    RuntimeSupervisorLive,
  );
}

/** Supplies the journal plus all browser and memory adapters for the POC. @category browser-layers @since 0.0.0 */
export function makeCabBrowserLayers() {
  return Layer.mergeAll(JournalMemoryLive, makeBrowserRuntimeLayers());
}
