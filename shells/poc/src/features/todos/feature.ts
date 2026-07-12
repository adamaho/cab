import { Effect, Schema } from "effect";
import { Decision } from "../../runtime/decision.ts";
import { defineCommand, defineEffect, defineEvent } from "../../runtime/definition.ts";
import { defineFeature } from "../../runtime/feature.ts";
import { TargetNotMounted, Viewport } from "../../runtime/services.ts";
import { todoTargetById, todosProjection } from "./queries.ts";

/** Names supported completion filters. @category todos @since 0.0.0 */
export type TodoFilter = "all" | "complete" | "incomplete";

/** Names supported todo sort keys. @category todos @since 0.0.0 */
export type TodoSort = "id" | "title" | "completed";

/** Is the todos feature's interaction state. @category todos @since 0.0.0 */
export interface TodosState {
  readonly page: number;
  readonly filter: TodoFilter;
  readonly sort: TodoSort;
  readonly selectedId?: number;
  readonly toggles: Readonly<Record<number, boolean>>;
}

const IdArgs = Schema.Struct({ id: Schema.Number });
const FilterSchema = Schema.Union([
  Schema.Literal("all"),
  Schema.Literal("complete"),
  Schema.Literal("incomplete"),
]);
const SortSchema = Schema.Union([
  Schema.Literal("id"),
  Schema.Literal("title"),
  Schema.Literal("completed"),
]);

/** Records a committed todo sort. @category todos-events @since 0.0.0 */
export const TodosSorted = defineEvent({
  name: "TodosSorted",
  version: 1,
  schema: Schema.Struct({ by: SortSchema }),
  scope: "session",
  retention: "compactable",
  render: (args) => `sorted todos by ${args.by}`,
});

/** Records a committed completion filter. @category todos-events @since 0.0.0 */
export const TodosFiltered = defineEvent({
  name: "TodosFiltered",
  version: 1,
  schema: Schema.Struct({ filter: FilterSchema }),
  scope: "session",
  retention: "compactable",
  render: (args) => `filtered todos by ${args.filter}`,
});

/** Records a selected semantic todo row. @category todos-events @since 0.0.0 */
export const TodoSelected = defineEvent({
  name: "TodoSelected",
  version: 1,
  schema: IdArgs,
  scope: "session",
  retention: "compactable",
  render: (args) => `selected todo ${args.id}`,
});

/** Records a local todo completion override. @category todos-events @since 0.0.0 */
export const TodoToggled = defineEvent({
  name: "TodoToggled",
  version: 1,
  schema: Schema.Struct({ id: Schema.Number, completed: Schema.Boolean }),
  scope: "session",
  retention: "permanent",
  render: (args) => `${args.completed ? "completed" : "reopened"} todo ${args.id}`,
});

/** Records a committed page transition. @category todos-events @since 0.0.0 */
export const TodoPageChanged = defineEvent({
  name: "TodoPageChanged",
  version: 1,
  schema: Schema.Struct({ page: Schema.Number }),
  scope: "session",
  retention: "compactable",
  render: (args) => `opened todo page ${args.page}`,
});

/** Records semantic intent to present a todo anchor. @category todos-events @since 0.0.0 */
export const TodoScrollRequested = defineEvent({
  name: "TodoScrollRequested",
  version: 1,
  schema: IdArgs,
  scope: "session",
  retention: "ephemeral",
  render: (args) => `scrolled to todo ${args.id}`,
});

/** Presents a semantic todo anchor only after exact render acknowledgement. @category todos-effects @since 0.0.0 */
export const ScrollToTodo = defineEffect<
  "todos.scrollToAnchor",
  { readonly id: number },
  void,
  TargetNotMounted,
  Viewport
>({
  name: "todos.scrollToAnchor",
  version: 1,
  description: "Bring a semantic todo anchor into the viewport",
  args: IdArgs,
  phase: "after-render",
  replay: "manual",
  authority: "session",
  concurrency: { _tag: "Latest", key: () => "todos.viewport" },
  run: ({ id }, context) =>
    Effect.gen(function* () {
      const viewport = yield* Viewport;
      yield* viewport.scrollTo(`#todo-${id}`, {
        behavior: context.mode === "live" ? "smooth" : "auto",
        block: "center",
      });
    }),
});

function validateTarget(
  query: <A>(query: import("../../runtime/query.ts").Query<A>) => A,
  state: TodosState,
  id: number,
) {
  const target = query(todoTargetById(id));
  if (target._tag === "Missing") {
    return Decision.reject(
      "todos.target.missing",
      `Todo ${id} does not exist in the current dataset`,
    );
  }
  if (target.page !== state.page) {
    return Decision.reject(
      "todos.target.off-page",
      `Todo ${id} is on page ${target.page}; navigate there first`,
    );
  }
  return target;
}

/** Requests a todo sort. @category todos-commands @since 0.0.0 */
export const sortTodos = defineCommand<"todos.sort", { readonly by: TodoSort }, TodosState>({
  name: "todos.sort",
  description: "Sort the todos table",
  args: Schema.Struct({ by: SortSchema }),
  exposure: "public",
  decide: ({ state }, args) =>
    state.sort === args.by
      ? Decision.noop("Todos are already sorted that way")
      : Decision.accept({ events: [TodosSorted.make(args)] }),
});

/** Requests a todo completion filter. @category todos-commands @since 0.0.0 */
export const filterTodos = defineCommand<
  "todos.filter",
  { readonly filter: TodoFilter },
  TodosState
>({
  name: "todos.filter",
  description: "Filter by completion status",
  args: Schema.Struct({ filter: FilterSchema }),
  exposure: "public",
  decide: ({ state }, args) =>
    state.filter === args.filter
      ? Decision.noop("That filter is already active")
      : Decision.accept({ events: [TodosFiltered.make(args)] }),
});

/** Requests semantic todo selection. @category todos-commands @since 0.0.0 */
export const selectTodo = defineCommand<"todos.select", { readonly id: number }, TodosState>({
  name: "todos.select",
  description: "Select a todo row",
  args: IdArgs,
  exposure: "public",
  decide: ({ state, query }, args) => {
    const target = validateTarget(query, state, args.id);
    if ("_tag" in target && target._tag === "Rejected") return target;
    return state.selectedId === args.id
      ? Decision.noop("That todo is already selected")
      : Decision.accept({ events: [TodoSelected.make(args)] });
  },
});

/** Requests a local completion override for a semantic todo. @category todos-commands @since 0.0.0 */
export const toggleTodo = defineCommand<
  "todos.toggle",
  { readonly id: number; readonly completed: boolean },
  TodosState
>({
  name: "todos.toggle",
  description: "Set a todo completion override",
  args: Schema.Struct({ id: Schema.Number, completed: Schema.Boolean }),
  exposure: "public",
  decide: ({ state, query }, args) => {
    const target = validateTarget(query, state, args.id);
    return "_tag" in target && target._tag === "Rejected"
      ? target
      : Decision.accept({ events: [TodoToggled.make(args)] });
  },
});

/** Requests a validated todo page transition. @category todos-commands @since 0.0.0 */
export const setTodoPage = defineCommand<"todos.setPage", { readonly page: number }, TodosState>({
  name: "todos.setPage",
  description: "Open a numbered page of todos",
  args: Schema.Struct({ page: Schema.Number }),
  exposure: "public",
  decide: ({ state, query }, args) => {
    if (!Number.isInteger(args.page) || args.page < 1) {
      return Decision.reject("todos.page.invalid", "Page must be a positive integer");
    }
    const projection = query(todosProjection);
    if (args.page > projection.pageCount) {
      return Decision.reject(
        "todos.page.missing",
        `Page ${args.page} does not exist; the last page is ${projection.pageCount}`,
      );
    }
    return state.page === args.page
      ? Decision.noop("That todo page is already active")
      : Decision.accept({ events: [TodoPageChanged.make(args)] });
  },
});

/** Requests post-render presentation of a visible semantic todo. @category todos-commands @since 0.0.0 */
export const scrollToTodo = defineCommand<"todos.scrollTo", { readonly id: number }, TodosState>({
  name: "todos.scrollTo",
  description: "Scroll a visible todo anchor into view",
  args: IdArgs,
  exposure: "public",
  possibleEffects: [ScrollToTodo.name],
  decide: ({ state, query }, args) => {
    const target = validateTarget(query, state, args.id);
    if ("_tag" in target && target._tag === "Rejected") return target;
    return Decision.accept({
      events: [TodoScrollRequested.make(args)],
      effects: [ScrollToTodo.make(args)],
    });
  },
});

/** Composes todo interactions, queries, fold, and viewport work. @category todos @since 0.0.0 */
export const todosFeature = defineFeature<"todos", TodosState, Viewport>({
  name: "todos",
  initialState: {
    page: 1,
    filter: "all",
    sort: "id",
    toggles: {},
  } satisfies TodosState,
  events: [
    TodosSorted,
    TodosFiltered,
    TodoSelected,
    TodoToggled,
    TodoPageChanged,
    TodoScrollRequested,
  ],
  commands: [sortTodos, filterTodos, selectTodo, toggleTodo, setTodoPage, scrollToTodo],
  effects: [ScrollToTodo],
  reduce: (state: TodosState, fact) => {
    const args = fact.args as Record<string, unknown>;
    switch (fact.name) {
      case "TodosSorted":
        return { ...state, page: 1, sort: args.by as TodoSort };
      case "TodosFiltered":
        return { ...state, page: 1, filter: args.filter as TodoFilter };
      case "TodoSelected":
        return { ...state, selectedId: args.id as number };
      case "TodoToggled":
        return {
          ...state,
          toggles: { ...state.toggles, [args.id as number]: args.completed as boolean },
        };
      case "TodoPageChanged":
        return { ...state, page: args.page as number };
      case "PageSizeChanged":
      case "RefreshCompleted":
        return { ...state, page: 1 };
      default:
        return state;
    }
  },
});
