import { createMemo, For, Show } from "solid-js";
import { refreshTodos } from "../features/ingest/feature.ts";
import { setPageSize, setTheme, type Theme } from "../features/settings/feature.ts";
import {
  filterTodos,
  selectTodo,
  setTodoPage,
  sortTodos,
  toggleTodo,
  type TodoFilter,
  type TodoSort,
} from "../features/todos/feature.ts";
import { useStore, useStoreView } from "./context.tsx";

const sectionHeading = "text-balance text-2xl font-semibold tracking-tight sm:text-3xl";
const sectionCopy = "max-w-[60ch] text-pretty text-base text-zinc-600 dark:text-zinc-400";

export function TodosPage() {
  const store = useStore();
  const { state } = useStoreView();
  const filteredRows = createMemo(() => {
    const s = state();
    const source = s.requestHash ? (store.todoPayload(s.requestHash) ?? []) : [];
    return source
      .map((todo) => ({ ...todo, completed: s.toggles[todo.id] ?? todo.completed }))
      .filter((todo) => s.filter === "all" || todo.completed === (s.filter === "complete"))
      .sort((a, b) =>
        s.sort === "title"
          ? a.title.localeCompare(b.title)
          : s.sort === "completed"
            ? Number(a.completed) - Number(b.completed)
            : a.id - b.id,
      );
  });
  const pageCount = createMemo(() =>
    Math.max(1, Math.ceil(filteredRows().length / state().pageSize)),
  );
  const rows = createMemo(() => {
    const start = (state().page - 1) * state().pageSize;
    return filteredRows().slice(start, start + state().pageSize);
  });
  return (
    <section class="flex flex-col gap-8">
      <header class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div class="flex min-w-0 flex-col gap-2">
          <h1 class={sectionHeading}>Todos</h1>
          <p class={sectionCopy}>Fetched payloads stay outside the journal.</p>
        </div>
        <button
          type="button"
          class="button-primary shrink-0"
          disabled={!store.isLive() || state().loading}
          onClick={() => store.dispatch(refreshTodos.make({}))}
        >
          {state().loading ? "Loading…" : "Refetch todos"}
        </button>
      </header>

      <div class="flex flex-wrap items-end gap-4 border-y border-zinc-950/10 py-4 dark:border-white/10">
        <label class="flex flex-col gap-1.5 text-base font-medium sm:text-sm" for="todo-status">
          Status
          <select
            id="todo-status"
            name="todo-status"
            class="field-control min-w-40"
            value={state().filter}
            disabled={!store.isLive()}
            onChange={(event) =>
              store.dispatch(filterTodos.make({ filter: event.currentTarget.value as TodoFilter }))
            }
          >
            <option value="all">All todos</option>
            <option value="complete">Complete</option>
            <option value="incomplete">Incomplete</option>
          </select>
        </label>
        <p class="text-base text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400">
          Showing {rows().length} of {filteredRows().length} matching todos.
        </p>
      </div>

      <Show when={state().error}>
        <p
          class="rounded-xl bg-red-500/10 p-4 text-base text-red-700 sm:text-sm dark:text-red-300"
          role="alert"
        >
          {state().error}
        </p>
      </Show>
      <Show when={!state().requestHash && !state().loading}>
        <p class={sectionCopy}>No todos loaded. Select Refetch todos.</p>
      </Show>

      <div class="-mx-4 -my-2 overflow-x-auto whitespace-nowrap sm:-mx-6 lg:-mx-8">
        <div class="inline-block min-w-full px-4 py-2 align-middle sm:px-6 lg:px-8">
          <table class="w-full">
            <thead>
              <tr class="border-b border-zinc-950/10 dark:border-white/10">
                <For each={["id", "title", "completed"] as TodoSort[]}>
                  {(key) => (
                    <th class="whitespace-nowrap py-3 pr-6 text-left font-medium text-zinc-500 dark:text-zinc-400">
                      <button
                        type="button"
                        class="focus-ring rounded-md text-base hover:text-zinc-950 sm:text-sm dark:hover:text-white"
                        disabled={!store.isLive()}
                        onClick={() => store.dispatch(sortTodos.make({ by: key }))}
                      >
                        {key[0]!.toUpperCase() + key.slice(1)}
                        {state().sort === key ? " ↑" : ""}
                      </button>
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-950/5 dark:divide-white/5">
              <For each={rows()}>
                {(todo) => (
                  <tr
                    id={`todo-${todo.id}`}
                    class="cursor-pointer bg-transparent hover:bg-zinc-950/2 [&.selected]:bg-emerald-500/8 dark:hover:bg-white/3 dark:[&.selected]:bg-emerald-400/10"
                    classList={{ selected: state().selectedId === todo.id }}
                    onClick={() => store.dispatch(selectTodo.make({ id: todo.id }))}
                  >
                    <td class="py-4 pr-6 text-base text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400">
                      {todo.id}
                    </td>
                    <td class="max-w-md truncate py-4 pr-6 text-base font-medium sm:text-sm">
                      {todo.title}
                    </td>
                    <td class="py-4">
                      <input
                        aria-label={`Toggle ${todo.title}`}
                        name={`todo-${todo.id}`}
                        type="checkbox"
                        class="focus-ring size-5 appearance-none rounded-md bg-white ring-1 ring-zinc-950/15 checked:bg-emerald-600 checked:ring-emerald-600 after:grid after:h-full after:place-items-center after:text-white after:content-['✓'] sm:size-4 dark:bg-white/5 dark:ring-white/15 dark:checked:bg-emerald-500 dark:checked:ring-emerald-500"
                        checked={todo.completed}
                        disabled={!store.isLive()}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          store.dispatch(
                            toggleTodo.make({
                              id: todo.id,
                              completed: event.currentTarget.checked,
                            }),
                          )
                        }
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>

      <nav
        aria-label="Todo pagination"
        class="flex items-center justify-between gap-4 border-t border-zinc-950/10 pt-4 dark:border-white/10"
      >
        <button
          type="button"
          class="button-secondary"
          disabled={!store.isLive() || state().page === 1}
          onClick={() => store.dispatch(setTodoPage.make({ page: state().page - 1 }))}
        >
          Previous
        </button>
        <p class="text-base text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400">
          Page {state().page} of {pageCount()}
        </p>
        <button
          type="button"
          class="button-secondary"
          disabled={!store.isLive() || state().page === pageCount()}
          onClick={() => store.dispatch(setTodoPage.make({ page: state().page + 1 }))}
        >
          Next
        </button>
      </nav>
    </section>
  );
}

export function SettingsPage() {
  const store = useStore();
  const { state } = useStoreView();
  return (
    <section class="flex max-w-2xl flex-col gap-8">
      <header class="flex flex-col gap-2">
        <h1 class={sectionHeading}>Settings</h1>
        <p class={sectionCopy}>Preferences are facts too. Every change can be replayed.</p>
      </header>
      <div class="divide-y divide-zinc-950/10 border-y border-zinc-950/10 dark:divide-white/10 dark:border-white/10">
        <label
          class="flex items-center justify-between gap-6 py-5 text-base font-medium sm:text-sm"
          for="theme"
        >
          <span>Theme</span>
          <select
            id="theme"
            name="theme"
            class="field-control min-w-32"
            value={state().theme}
            disabled={!store.isLive()}
            onChange={(event) =>
              store.dispatch(setTheme.make({ theme: event.currentTarget.value as Theme }))
            }
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label
          class="flex items-center justify-between gap-6 py-5 text-base font-medium sm:text-sm"
          for="page-size"
        >
          <span>Table page size</span>
          <select
            id="page-size"
            name="page-size"
            class="field-control min-w-32"
            value={state().pageSize}
            disabled={!store.isLive()}
            onChange={(event) =>
              store.dispatch(setPageSize.make({ size: Number(event.currentTarget.value) }))
            }
          >
            <For each={[5, 10, 20, 50]}>{(size) => <option value={size}>{size} rows</option>}</For>
          </select>
        </label>
      </div>
    </section>
  );
}

export function AboutPage() {
  return (
    <section class="flex max-w-3xl flex-col gap-6">
      <h1 class="font-mono text-sm font-medium tracking-wide text-emerald-700 dark:text-emerald-300">
        About
      </h1>
      <h2 class="max-w-[24ch] text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
        Interfaces become understandable when every action leaves a fact.
      </h2>
      <p class="max-w-[60ch] text-pretty text-base text-zinc-600 sm:text-lg dark:text-zinc-400">
        Cab turns a living interface into an attributed, replayable shared workspace for humans and
        agents.
      </p>
    </section>
  );
}
