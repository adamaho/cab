import { Match, Switch } from "solid-js";
import { Devtools } from "../devtools/devtools.tsx";
import { navigate } from "../features/router/feature.ts";
import { useStore, useStoreView } from "./context.tsx";
import { AboutPage, SettingsPage, TodosPage } from "./pages.tsx";

export function App() {
  const store = useStore();
  const { state } = useStoreView();
  return (
    <div
      class={`app isolate min-h-dvh bg-white font-sans text-zinc-950 antialiased dark:bg-zinc-950 dark:text-zinc-100 ${state().theme}`}
    >
      <header class="sticky top-0 z-20 border-b border-zinc-950/10 bg-white/90 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
        <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <a
              aria-label="Homepage"
              class="focus-ring rounded-md text-lg font-semibold tracking-tight"
              href="/"
              onClick={(event) => {
                event.preventDefault();
                store.dispatch(navigate.make({ route: "todos" }));
              }}
            >
              Cab
            </a>
            <span class="rounded-full bg-emerald-500/10 px-2 py-1 font-mono text-sm text-emerald-700 dark:text-emerald-300">
              POC
            </span>
          </div>
          <span class="order-2 rounded-full bg-zinc-950/5 px-2.5 py-1 text-sm tabular-nums text-zinc-600 dark:bg-white/10 dark:text-zinc-300 sm:order-3">
            {store.isLive() ? "Live" : `History #${store.viewingSequence()}`}
          </span>
          <nav
            aria-label="Primary"
            class="order-3 flex w-full gap-1 overflow-x-auto rounded-xl bg-zinc-950/5 p-1 sm:order-2 sm:w-auto dark:bg-white/5"
          >
            {(["todos", "settings", "about"] as const).map((route) => (
              <button
                type="button"
                aria-current={state().route === route ? "page" : undefined}
                class="focus-ring min-h-10 flex-1 rounded-lg px-3 text-base font-medium text-zinc-500 hover:text-zinc-950 aria-[current=page]:bg-white aria-[current=page]:text-zinc-950 aria-[current=page]:ring-1 aria-[current=page]:ring-zinc-950/5 sm:min-h-8 sm:flex-none sm:text-sm dark:text-zinc-400 dark:hover:text-white dark:aria-[current=page]:bg-white/10 dark:aria-[current=page]:text-white dark:aria-[current=page]:ring-white/5"
                disabled={!store.isLive()}
                onClick={() => store.dispatch(navigate.make({ route }))}
              >
                {route[0]!.toUpperCase() + route.slice(1)}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <Switch>
          <Match when={state().route === "todos"}>
            <TodosPage />
          </Match>
          <Match when={state().route === "settings"}>
            <SettingsPage />
          </Match>
          <Match when={state().route === "about"}>
            <AboutPage />
          </Match>
        </Switch>
      </main>
      <Devtools />
    </div>
  );
}
