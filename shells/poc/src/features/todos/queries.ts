import { defineQuery } from "../../runtime/query.ts";
import type { TodoRecord } from "../../runtime/services.ts";
import type { PocState } from "../state.ts";

/** Is one todo after local completion overrides are folded. @category todos-queries @since 0.0.0 */
export interface VisibleTodo extends TodoRecord {}

/** Is the complete filtered/sorted dataset and pagination metadata. @category todos-queries @since 0.0.0 */
export interface TodosProjection {
  readonly todos: readonly VisibleTodo[];
  readonly pageTodos: readonly VisibleTodo[];
  readonly pageCount: number;
}

function isTodo(value: unknown): value is TodoRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "number" &&
    typeof (value as { title?: unknown }).title === "string" &&
    typeof (value as { completed?: unknown }).completed === "boolean"
  );
}

/** Projects cached todos through folded overrides, filtering, sorting, and paging. @category todos-queries @since 0.0.0 */
export const todosProjection = defineQuery<TodosProjection>(({ state, cache }) => {
  const app = state as PocState;
  const cached = app.ingest.requestHash ? cache.get(app.ingest.requestHash) : undefined;
  const source = Array.isArray(cached) ? cached.filter(isTodo) : [];
  const todos = source
    .map((todo) => ({
      ...todo,
      completed: app.todos.toggles[todo.id] ?? todo.completed,
    }))
    .filter(
      (todo) => app.todos.filter === "all" || todo.completed === (app.todos.filter === "complete"),
    )
    .sort((left, right) => {
      if (app.todos.sort === "title") return left.title.localeCompare(right.title);
      if (app.todos.sort === "completed") return Number(left.completed) - Number(right.completed);
      return left.id - right.id;
    });
  const pageCount = Math.max(1, Math.ceil(todos.length / app.settings.pageSize));
  const start = (app.todos.page - 1) * app.settings.pageSize;
  return {
    todos,
    pageTodos: todos.slice(start, start + app.settings.pageSize),
    pageCount,
  };
});

/** Locates a semantic todo and the page containing it. @category todos-queries @since 0.0.0 */
export function todoTargetById(id: number) {
  return defineQuery<
    | { readonly _tag: "Missing" }
    | { readonly _tag: "Found"; readonly todo: VisibleTodo; readonly page: number }
  >((context) => {
    const app = context.state as PocState;
    const projection = todosProjection.run(context);
    const index = projection.todos.findIndex((todo) => todo.id === id);
    return index < 0
      ? { _tag: "Missing" }
      : {
          _tag: "Found",
          todo: projection.todos[index] as VisibleTodo,
          page: Math.floor(index / app.settings.pageSize) + 1,
        };
  });
}
