import { createSignal, For, Show } from "solid-js";
import { runLocalAgent, type AgentStep } from "../agent/local-agent.ts";
import { useBrowserMcp, useEffects, useStore, useStoreView } from "../app/context.tsx";
import { describeScreen } from "../app/screen-context.ts";
import { refreshTodos } from "../features/ingest/feature.ts";
import { navigate } from "../features/router/feature.ts";
import { setTheme } from "../features/settings/feature.ts";
import {
  filterTodos,
  scrollToTodo,
  toggleTodo,
  type TodoFilter,
} from "../features/todos/feature.ts";
import type { Fact } from "../store/types.ts";

function sentence(fact: Fact): string {
  const who = `${fact.actor.kind === "agent" ? "Agent" : "Human"} ${fact.actor.id}`;
  const args = fact.args as Record<string, unknown>;
  const verbs: Record<string, string> = {
    Navigated: `navigated to ${args.route}`,
    RefreshRequested: "requested fresh todos",
    RefreshCompleted: `loaded ${args.count} todos`,
    RefreshFailed: `failed to load todos: ${args.message}`,
    TodosSorted: `sorted todos by ${args.by}`,
    TodosFiltered: `filtered todos by ${args.filter}`,
    TodoSelected: `selected todo ${args.id}`,
    TodoToggled: `toggled todo ${args.id} ${args.completed ? "done" : "not done"}`,
    TodoPageChanged: `opened todo page ${args.page}`,
    TodoScrollRequested: `scrolled to todo ${args.id}`,
    ThemeChanged: `changed theme to ${args.theme}`,
    PageSizeChanged: `changed page size to ${args.size}`,
  };
  return `${who} ${verbs[fact.name] ?? fact.name}`;
}

export function Devtools() {
  const store = useStore();
  const effects = useEffects();
  const browserMcp = useBrowserMcp();
  const view = useStoreView();
  const [open, setOpen] = createSignal(true);
  const [tab, setTab] = createSignal<"timeline" | "effects" | "screen" | "commands" | "agent">(
    "timeline",
  );
  const [agentFailure, setAgentFailure] = createSignal<string>();
  const [agentGoal, setAgentGoal] = createSignal("Show incomplete todos and switch to dark mode");
  const [agentStatus, setAgentStatus] = createSignal<string>();
  const [modelProgress, setModelProgress] = createSignal(0);
  const [agentSteps, setAgentSteps] = createSignal<readonly AgentStep[]>([]);
  const [agentRunning, setAgentRunning] = createSignal(false);
  let agentAbort: AbortController | undefined;
  const [scrollTodoId, setScrollTodoId] = createSignal<number>();
  const [effectFailure, setEffectFailure] = createSignal<string>();
  const [manualReplayEnabled, setManualReplayEnabled] = createSignal(false);

  function isLive() {
    return view.sequence() === view.journal().length;
  }

  function screenContext() {
    view.sequence();
    view.journal();
    return describeScreen(store, view.state());
  }

  function visibleTodos() {
    const content = screenContext().content;
    return (content.visibleTodos ?? []) as readonly {
      readonly id: number;
      readonly title: string;
      readonly anchor: string;
    }[];
  }

  function visibleInvocations() {
    view.revision();
    return store
      .invocations()
      .filter((invocation) => invocation.triggerSequence <= view.sequence());
  }

  async function replayInvocation(invocationId: string, effectName: string) {
    if (
      !manualReplayEnabled() ||
      !window.confirm(
        `Replay ${effectName} for invocation ${invocationId}? This runs presentation work again but does not dispatch an outcome.`,
      )
    ) {
      return;
    }
    setEffectFailure(undefined);
    try {
      await effects.replay(invocationId, true);
    } catch (error) {
      setEffectFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function waitForRefresh(): Promise<void> {
    if (!store.state().loading) return;
    await new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe(() => {
        if (!store.state().loading) {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  async function runAgent() {
    if (!store.isLive()) {
      setAgentStatus("Return to Live before running the agent");
      return;
    }
    agentAbort = new AbortController();
    setAgentRunning(true);
    setAgentStatus("Preparing the WebLLM model…");
    setModelProgress(0);
    setAgentSteps([]);
    const result = await runLocalAgent({
      goal: agentGoal(),
      mcp: browserMcp,
      signal: agentAbort.signal,
      onModelProgress: (report) => {
        setModelProgress(report.progress);
        setAgentStatus(report.text);
      },
      onStatus: setAgentStatus,
      onStep: (step) => setAgentSteps((steps) => [...steps, step]),
    });
    setAgentStatus(result.message);
    setAgentRunning(false);
    agentAbort = undefined;
  }

  async function simulate() {
    const actor = { kind: "agent", id: "bot" } as const;
    setAgentFailure(undefined);
    try {
      if (!store.isLive()) throw new Error("Return to Live before simulating the agent");
      if (!store.state().requestHash && !store.state().loading) {
        const result = store.dispatch(refreshTodos.make({}), actor);
        if (result.rejected) throw new Error(result.rejected);
      }
      await waitForRefresh();
      if (store.state().error) throw new Error(`Todo refresh failed: ${store.state().error}`);
      const requestHash = store.state().requestHash;
      const rows = requestHash ? store.todoPayload(requestHash) : undefined;
      const first = rows?.[0];
      if (!first) throw new Error("Todo refresh returned no rows to toggle");
      const matchingFilter = first.completed ? "complete" : "incomplete";
      const filter = store.state().filter === matchingFilter ? "all" : matchingFilter;
      const actions = [
        store.dispatch(navigate.make({ route: "todos" }), actor),
        store.dispatch(filterTodos.make({ filter: filter as TodoFilter }), actor),
        store.dispatch(
          toggleTodo.make({
            id: first.id,
            completed: !(store.state().toggles[first.id] ?? first.completed),
          }),
          actor,
        ),
        store.dispatch(
          setTheme.make({ theme: store.state().theme === "dark" ? "light" : "dark" }),
          actor,
        ),
      ];
      const rejected = actions.find((result) => result.rejected)?.rejected;
      if (rejected) throw new Error(rejected);
    } catch (error) {
      setAgentFailure(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <aside class="fixed right-3 bottom-3 z-50 flex max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] flex-col items-end sm:right-5 sm:bottom-5 sm:w-[min(42rem,calc(100%-2.5rem))]">
      <Show when={open()}>
        <div class="mb-3 flex min-h-0 w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10">
          <header class="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-950/10 p-3 dark:border-white/10">
            <div class="min-w-0">
              <h2 class="truncate text-base font-semibold">Theatre mode</h2>
              <p class="text-base text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400">
                Sequence {view.sequence()} of {view.journal().length}
              </p>
            </div>
            <button type="button" class="button-secondary shrink-0" onClick={() => setOpen(false)}>
              Close
            </button>
          </header>

          <div
            class="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-950/10 p-2 dark:border-white/10"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab() === "timeline"}
              class="focus-ring min-h-10 flex-1 rounded-lg px-3 text-base font-medium text-zinc-500 aria-selected:bg-zinc-950/5 aria-selected:text-zinc-950 sm:min-h-8 sm:text-sm dark:aria-selected:bg-white/10 dark:aria-selected:text-white"
              onClick={() => setTab("timeline")}
            >
              Timeline
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab() === "effects"}
              class="focus-ring min-h-10 flex-1 rounded-lg px-3 text-base font-medium text-zinc-500 aria-selected:bg-zinc-950/5 aria-selected:text-zinc-950 sm:min-h-8 sm:text-sm dark:aria-selected:bg-white/10 dark:aria-selected:text-white"
              onClick={() => setTab("effects")}
            >
              Effects
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab() === "screen"}
              class="focus-ring min-h-10 flex-1 rounded-lg px-3 text-base font-medium text-zinc-500 aria-selected:bg-zinc-950/5 aria-selected:text-zinc-950 sm:min-h-8 sm:text-sm dark:aria-selected:bg-white/10 dark:aria-selected:text-white"
              onClick={() => setTab("screen")}
            >
              Screen context
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab() === "commands"}
              class="focus-ring min-h-10 flex-1 rounded-lg px-3 text-base font-medium text-zinc-500 aria-selected:bg-zinc-950/5 aria-selected:text-zinc-950 sm:min-h-8 sm:text-sm dark:aria-selected:bg-white/10 dark:aria-selected:text-white"
              onClick={() => setTab("commands")}
            >
              Command palette
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab() === "agent"}
              class="focus-ring min-h-10 flex-1 rounded-lg px-3 text-base font-medium text-zinc-500 aria-selected:bg-zinc-950/5 aria-selected:text-zinc-950 sm:min-h-8 sm:text-sm dark:aria-selected:bg-white/10 dark:aria-selected:text-white"
              onClick={() => setTab("agent")}
            >
              Local agent
            </button>
          </div>

          <Show when={tab() === "timeline"}>
            <section class="flex min-h-0 flex-col gap-4 p-4">
              <div class="flex flex-wrap items-center gap-3">
                <input
                  aria-label="Journal sequence"
                  name="journal-sequence"
                  class="min-w-32 flex-1 accent-emerald-600"
                  type="range"
                  min="0"
                  max={view.journal().length}
                  value={view.sequence()}
                  onInput={(event) => store.scrub(Number(event.currentTarget.value))}
                />
                <button
                  type="button"
                  class="button-secondary"
                  disabled={isLive()}
                  onClick={() => store.live()}
                >
                  Live
                </button>
                <Show when={!isLive()}>
                  <button
                    type="button"
                    class="button-primary"
                    onClick={async () => {
                      const futureCount = store.journal().length - store.viewingSequence();
                      if (
                        window.confirm(
                          `Delete ${futureCount} future ${futureCount === 1 ? "event" : "events"} and continue from here? This cannot be undone.`,
                        )
                      ) {
                        await store.continueFrom();
                      }
                    }}
                  >
                    Continue from here
                  </button>
                </Show>
                <button
                  type="button"
                  class="button-primary"
                  disabled={!isLive()}
                  onClick={simulate}
                >
                  Simulate agent
                </button>
              </div>
              <Show when={!isLive()}>
                <p class="text-sm text-amber-700 dark:text-amber-300" role="note">
                  Continuing creates a new runtime branch. Already completed external work is not
                  undone.
                </p>
              </Show>
              <Show when={agentFailure()}>
                {(message) => (
                  <p
                    class="rounded-lg bg-red-500/10 p-3 text-base text-red-700 sm:text-sm dark:text-red-300"
                    role="alert"
                  >
                    {message()}
                  </p>
                )}
              </Show>
              <ol
                class="min-h-0 divide-y divide-zinc-950/5 overflow-y-auto dark:divide-white/5"
                role="list"
              >
                <For each={view.journal()}>
                  {(fact) => (
                    <li
                      class="flex gap-3 py-3 text-base sm:text-sm"
                      classList={{ "opacity-35": fact.sequence > view.sequence() }}
                    >
                      <span
                        class={`mt-1.5 size-2 shrink-0 rounded-full ${fact.actor.kind === "agent" ? "bg-violet-500" : "bg-emerald-500"}`}
                        aria-hidden="true"
                      />
                      <p class="min-w-0 text-pretty">
                        <strong class="font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
                          #{fact.sequence}
                        </strong>{" "}
                        {sentence(fact)}
                      </p>
                    </li>
                  )}
                </For>
              </ol>
            </section>
          </Show>

          <Show when={tab() === "effects"}>
            <section
              aria-label="Effect definitions and executions"
              class="flex min-h-0 flex-col gap-5 overflow-y-auto p-4"
            >
              <div>
                <h3 class="text-base font-semibold">Effect definitions</h3>
                <p class="text-pretty text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
                  Policies are registered at runtime. Effects can be selected only by commands.
                </p>
              </div>
              <ul class="divide-y divide-zinc-950/5 dark:divide-white/5" role="list">
                <For each={effects.definitions()}>
                  {(definition) => (
                    <li class="flex flex-col gap-1 py-3 first:pt-0">
                      <h4 class="font-mono text-base font-medium text-emerald-700 sm:text-sm dark:text-emerald-300">
                        {definition.name}@{definition.version}
                      </h4>
                      <p class="text-base text-zinc-600 sm:text-sm dark:text-zinc-400">
                        {definition.description}
                      </p>
                      <p class="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                        {definition.phase} · replay {definition.replay} · {definition.authority} ·{" "}
                        {definition.concurrency}
                      </p>
                    </li>
                  )}
                </For>
              </ul>

              <div>
                <h3 class="text-base font-semibold">Invocation telemetry</h3>
                <p class="text-pretty text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
                  Command, commit, invocation, correlation, execution, and outcome fact IDs remain
                  linked.
                </p>
              </div>
              <label class="flex items-center gap-2 text-base text-zinc-600 sm:text-sm dark:text-zinc-300">
                <input
                  type="checkbox"
                  name="enable-manual-effect-replay"
                  class="size-5 accent-emerald-600 sm:size-4"
                  checked={manualReplayEnabled()}
                  onChange={(event) => setManualReplayEnabled(event.currentTarget.checked)}
                />
                Enable manual presentation replay
              </label>
              <Show when={effectFailure()}>
                {(message) => (
                  <p
                    class="rounded-lg bg-red-500/10 p-3 text-red-700 dark:text-red-300"
                    role="alert"
                  >
                    {message()}
                  </p>
                )}
              </Show>
              <ol class="divide-y divide-zinc-950/5 dark:divide-white/5" role="list">
                <For each={visibleInvocations()}>
                  {(invocation) => {
                    function definition() {
                      return effects
                        .definitions()
                        .find((item) => item.name === invocation.definition);
                    }
                    function linkedExecutions() {
                      return effects
                        .executions()
                        .filter((execution) => execution.invocationId === invocation.id);
                    }
                    function commandFacts() {
                      return view
                        .journal()
                        .filter((fact) => fact.commandId === invocation.commandId);
                    }
                    function outcomeFacts() {
                      return view.journal().filter((fact) => fact.causationId === invocation.id);
                    }
                    return (
                      <li class="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h4 class="font-mono text-sm font-medium">{invocation.definition}</h4>
                            <p class="text-sm text-zinc-500 dark:text-zinc-400">
                              {invocation.phase} · outbox {invocation.status}
                            </p>
                          </div>
                          <Show when={definition()?.replay === "manual"}>
                            <button
                              type="button"
                              class="button-secondary"
                              disabled={!manualReplayEnabled()}
                              onClick={() =>
                                void replayInvocation(invocation.id, invocation.definition)
                              }
                            >
                              Replay this invocation
                            </button>
                          </Show>
                        </div>
                        <dl class="grid gap-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                          <div>
                            <dt class="inline font-semibold">command </dt>
                            <dd class="inline">{invocation.commandId}</dd>
                          </div>
                          <div>
                            <dt class="inline font-semibold">commit </dt>
                            <dd class="inline">{invocation.commitId}</dd>
                          </div>
                          <div>
                            <dt class="inline font-semibold">invocation </dt>
                            <dd class="inline">{invocation.id}</dd>
                          </div>
                          <div>
                            <dt class="inline font-semibold">correlation </dt>
                            <dd class="inline">{invocation.correlationId}</dd>
                          </div>
                        </dl>
                        <ul
                          class="flex flex-col gap-1"
                          aria-label={`Executions for ${invocation.id}`}
                        >
                          <For each={linkedExecutions()}>
                            {(execution) => (
                              <li class="font-mono text-xs">
                                execution {execution.id} · {execution.mode} · {execution.status}
                                {execution.detail ? ` · ${execution.detail}` : ""}
                              </li>
                            )}
                          </For>
                        </ul>
                        <p class="text-xs text-zinc-500 dark:text-zinc-400">
                          facts{" "}
                          {commandFacts()
                            .map((fact) => `#${fact.sequence} ${fact.name}`)
                            .join(", ") || "none"}
                          {" · outcome "}
                          {outcomeFacts()
                            .map((fact) => `#${fact.sequence} ${fact.name}`)
                            .join(", ") || "none"}
                        </p>
                      </li>
                    );
                  }}
                </For>
              </ol>
            </section>
          </Show>

          <Show when={tab() === "screen"}>
            <section class="min-h-0 overflow-y-auto p-4">
              <div class="flex flex-col gap-4">
                <div>
                  <h3 class="text-base font-semibold">Available on {screenContext().screen}</h3>
                  <p class="text-pretty text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
                    This is the structured context exposed to an agent at the selected sequence.
                  </p>
                </div>
                <Show when={screenContext().screen === "todos" && visibleTodos().length > 0}>
                  <div class="flex flex-col gap-3 rounded-xl bg-zinc-950/4 p-3 dark:bg-black/20">
                    <label
                      class="flex flex-col gap-1.5 text-base font-medium sm:text-sm"
                      for="scroll-todo"
                    >
                      Test semantic scrolling
                      <select
                        id="scroll-todo"
                        name="scroll-todo"
                        class="field-control w-full"
                        value={scrollTodoId() ?? visibleTodos()[0]?.id}
                        disabled={!isLive()}
                        onChange={(event) => setScrollTodoId(Number(event.currentTarget.value))}
                      >
                        <For each={visibleTodos()}>
                          {(todo) => (
                            <option value={todo.id}>
                              Todo {todo.id}: {todo.title}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                    <button
                      type="button"
                      class="button-primary self-start"
                      disabled={!isLive()}
                      onClick={() => {
                        const id = scrollTodoId() ?? visibleTodos()[0]?.id;
                        if (id !== undefined) store.dispatch(scrollToTodo.make({ id }));
                      }}
                    >
                      Test scroll to todo
                    </button>
                  </div>
                </Show>
                <ul class="divide-y divide-zinc-950/5 dark:divide-white/5" role="list">
                  <For each={screenContext().capabilities}>
                    {(capability) => (
                      <li class="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                        <h4 class="font-mono text-base font-medium text-emerald-700 sm:text-sm dark:text-emerald-300">
                          {capability.command}
                        </h4>
                        <p class="text-pretty text-base text-zinc-600 sm:text-sm dark:text-zinc-400">
                          {capability.description}.
                        </p>
                      </li>
                    )}
                  </For>
                </ul>
                <pre class="overflow-x-auto rounded-lg bg-zinc-950/4 p-3 font-mono text-sm dark:bg-black/20">
                  {JSON.stringify(screenContext(), null, 2)}
                </pre>
              </div>
            </section>
          </Show>

          <Show when={tab() === "agent"}>
            <section class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
              <div>
                <h3 class="text-base font-semibold">On-device browser agent</h3>
                <p class="text-pretty text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
                  Runs Qwen2.5 locally with WebLLM and WebGPU. The first run downloads the model;
                  observations and commands stay in this tab.
                </p>
              </div>
              <label
                class="flex flex-col gap-1.5 text-base font-medium sm:text-sm"
                for="agent-goal"
              >
                Goal
                <textarea
                  id="agent-goal"
                  class="field-control min-h-24 resize-y"
                  value={agentGoal()}
                  disabled={agentRunning()}
                  onInput={(event) => setAgentGoal(event.currentTarget.value)}
                />
              </label>
              <div class="flex gap-3">
                <button
                  type="button"
                  class="button-primary"
                  disabled={agentRunning() || !isLive()}
                  onClick={() => void runAgent()}
                >
                  Run local agent
                </button>
                <button
                  type="button"
                  class="button-secondary"
                  disabled={!agentRunning()}
                  onClick={() => agentAbort?.abort()}
                >
                  Stop
                </button>
              </div>
              <Show when={agentRunning() && modelProgress() > 0 && modelProgress() < 1}>
                <progress
                  class="h-2 w-full accent-emerald-600"
                  aria-label="Model download progress"
                  max="1"
                  value={modelProgress()}
                />
              </Show>
              <Show when={agentStatus()}>
                {(status) => (
                  <p class="text-base text-zinc-600 sm:text-sm dark:text-zinc-300" role="status">
                    {status()}
                  </p>
                )}
              </Show>
              <ol class="divide-y divide-zinc-950/5 dark:divide-white/5" aria-label="Agent steps">
                <For each={agentSteps()}>
                  {(step, index) => (
                    <li class="py-3 text-base sm:text-sm">
                      <strong class="font-medium">Step {index() + 1}</strong>{" "}
                      {step.command ? `${step.command} ${JSON.stringify(step.args)}` : step.summary}
                    </li>
                  )}
                </For>
              </ol>
            </section>
          </Show>

          <Show when={tab() === "commands"}>
            <section class="min-h-0 overflow-y-auto p-4">
              <ul class="divide-y divide-zinc-950/5 dark:divide-white/5" role="list">
                <For each={store.describe()}>
                  {(command) => (
                    <li class="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                      <h3 class="font-mono text-base font-medium text-emerald-700 sm:text-sm dark:text-emerald-300">
                        {command.name}
                      </h3>
                      <p class="text-pretty text-base text-zinc-600 sm:text-sm dark:text-zinc-400">
                        {command.description}.
                      </p>
                      <pre class="overflow-x-auto rounded-lg bg-zinc-950/4 p-3 font-mono text-sm dark:bg-black/20">
                        {JSON.stringify(command.argsSchema, null, 2)}
                      </pre>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </div>
      </Show>
      <button
        type="button"
        aria-expanded={open()}
        class="button-primary shadow-lg dark:shadow-none"
        onClick={() => setOpen(!open())}
      >
        {open() ? "Hide theatre mode" : "Open theatre mode"}
      </button>
    </aside>
  );
}
