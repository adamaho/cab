import type { CommandDescription } from "../runtime/model.ts";
import type { Store } from "../store/store.ts";
import type { AppState } from "../store/types.ts";

export interface ScreenCapability {
  readonly command: string;
  readonly description: string;
  readonly argsSchema: object;
  readonly possibleEffects: CommandDescription["possibleEffects"];
}

export interface ScreenContext {
  readonly screen: AppState["route"];
  readonly sequence: number;
  readonly mode: "live" | "history";
  readonly capabilities: readonly ScreenCapability[];
  readonly content: Readonly<Record<string, unknown>>;
}

const capabilitiesByScreen: Readonly<Record<AppState["route"], readonly string[]>> = {
  todos: [
    "router.navigate",
    "todos.refresh",
    "todos.sort",
    "todos.filter",
    "todos.select",
    "todos.toggle",
    "todos.setPage",
    "todos.scrollTo",
  ],
  settings: ["router.navigate", "settings.setTheme", "settings.setPageSize"],
  about: ["router.navigate"],
};

/** Describes only route-relevant public commands and historically selected cached content. @category screen @since 0.0.0 */
export function describeScreen(store: Store, state: AppState): ScreenContext {
  const descriptions = new Map(store.describe().map((command) => [command.name, command]));
  const capabilities = capabilitiesByScreen[state.route].flatMap((name) => {
    const command = descriptions.get(name);
    return command
      ? [
          {
            command: command.name,
            description: command.description,
            argsSchema: command.argsSchema,
            possibleEffects: command.possibleEffects,
          },
        ]
      : [];
  });

  if (state.route !== "todos") {
    return {
      screen: state.route,
      sequence: store.viewingSequence(),
      mode: store.isLive() ? "live" : "history",
      capabilities,
      content:
        state.route === "settings"
          ? { theme: state.theme, pageSize: state.pageSize }
          : { heading: "About", summary: "Cab is an attributed, replayable shared workspace." },
    };
  }

  const source = state.requestHash ? (store.todoPayload(state.requestHash) ?? []) : [];
  const filtered = source
    .map((todo) => ({ ...todo, completed: state.toggles[todo.id] ?? todo.completed }))
    .filter((todo) => state.filter === "all" || todo.completed === (state.filter === "complete"))
    .sort((left, right) =>
      state.sort === "title"
        ? left.title.localeCompare(right.title)
        : state.sort === "completed"
          ? Number(left.completed) - Number(right.completed)
          : left.id - right.id,
    );
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  const lastScroll = store
    .journal()
    .slice(0, store.viewingSequence())
    .reverse()
    .find((fact) => fact.name === "TodoScrollRequested");
  const start = (state.page - 1) * state.pageSize;
  const visible = filtered.slice(start, start + state.pageSize);

  return {
    screen: "todos",
    sequence: store.viewingSequence(),
    mode: store.isLive() ? "live" : "history",
    capabilities,
    content: {
      page: state.page,
      pageCount,
      pageSize: state.pageSize,
      totalTodos: filtered.length,
      filter: state.filter,
      sort: state.sort,
      selectedId: state.selectedId ?? null,
      requestHash: state.requestHash ?? null,
      lastScrollIntent: lastScroll
        ? {
            todoId: (lastScroll.args as { id: number }).id,
            anchor: `#todo-${(lastScroll.args as { id: number }).id}`,
            sequence: lastScroll.sequence,
          }
        : null,
      visibleTodos: visible.map((todo) => ({
        id: todo.id,
        title: todo.title,
        completed: todo.completed,
        anchor: `#todo-${todo.id}`,
      })),
    },
  };
}
