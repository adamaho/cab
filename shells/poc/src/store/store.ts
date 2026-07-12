import { signal } from "alien-signals";
import { Context, Effect, Fiber, Layer, ManagedRuntime, Option, Stream } from "effect";
import { createPocRuntime } from "../features/index.ts";
import type { PocState } from "../features/state.ts";
import type { CommandInvocation } from "../runtime/definition.ts";
import { JournalMemoryLive } from "../runtime/journal.ts";
import type {
  CommandDescription,
  CommittedEffectInvocation,
  EffectExecution,
  RenderToken,
  RuntimeDescription,
  RuntimeSnapshot,
} from "../runtime/model.ts";
import type { CabRuntime, DispatchResult } from "../runtime/runtime.ts";
import {
  CacheError,
  cloneSerializable,
  hashTodos,
  IdGeneratorLive,
  QueryCache,
  RenderCoordinatorLive,
  RuntimeClock,
  RuntimeSupervisor,
  TargetNotMounted,
  TodoApi,
  TodoApiError,
  TodoCache,
  Viewport,
  type TodoRecord,
} from "../runtime/index.ts";
import { initialState, type Actor, type AppState, type Fact, type Todo } from "./types.ts";

const human: Actor = { kind: "human", id: "adam" };

type PocCabRuntime = CabRuntime<PocState>;

class PocRuntimeService extends Context.Service<PocRuntimeService, PocCabRuntime>()(
  "cab/poc/Runtime",
) {}

/** Is the compatibility result returned by synchronous POC UI dispatches. @category store @since 0.0.0 */
export interface StoreDispatchResult {
  readonly events: readonly Fact[];
  readonly rejected?: string;
  readonly result: DispatchResult;
}

/** Provides the test adapter seams consumed by StoreProvider and focused store tests. @category store @since 0.0.0 */
export interface StoreAdapters {
  readonly fetchTodos?: () => Promise<readonly Todo[]>;
  readonly scrollToAnchor?: (anchor: string, behavior: ScrollBehavior) => void;
}

/** Is the stable adapter over the scoped Effect-native POC runtime. @category store @since 0.0.0 */
export interface Store {
  readonly state: () => AppState;
  readonly journal: () => readonly Fact[];
  readonly viewingSequence: () => number;
  readonly isLive: () => boolean;
  readonly revision: () => number;
  readonly renderToken: () => RenderToken;
  readonly invocations: () => readonly CommittedEffectInvocation[];
  readonly executions: () => readonly EffectExecution[];
  readonly defects: () => readonly unknown[];
  readonly dispatch: <Name extends string, Args>(
    invocation: CommandInvocation<Name, Args>,
    actor?: Actor,
  ) => StoreDispatchResult;
  readonly dispatchEffect: <Name extends string, Args>(
    invocation: CommandInvocation<Name, Args>,
    actor?: Actor,
  ) => Effect.Effect<DispatchResult, unknown>;
  readonly dispatchUnknown: (name: string, args: unknown, actor: Actor) => Promise<DispatchResult>;
  readonly scrub: (sequence: number) => void;
  readonly continueFrom: () => Promise<void>;
  readonly live: () => void;
  readonly acknowledgeRender: (token: RenderToken) => void;
  readonly replayEffect: (invocationId: string, allow: boolean) => Promise<unknown>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribeCommitted: (listener: (facts: readonly Fact[]) => void) => () => void;
  readonly describe: () => readonly CommandDescription[];
  readonly describeRuntime: () => RuntimeDescription;
  readonly configure: (adapters: StoreAdapters) => void;
  readonly dispose: () => Promise<void>;
  readonly todoPayload: (hash: string) => readonly Todo[] | undefined;
  readonly cachedPayloadCount: () => number;
}

function flatten(state: Readonly<PocState>): AppState {
  return cloneSerializable({
    route: state.router.route,
    theme: state.settings.theme,
    pageSize: state.settings.pageSize,
    page: state.todos.page,
    filter: state.todos.filter,
    sort: state.todos.sort,
    ...(state.todos.selectedId === undefined ? {} : { selectedId: state.todos.selectedId }),
    toggles: state.todos.toggles,
    ...(state.ingest.requestHash === undefined ? {} : { requestHash: state.ingest.requestHash }),
    ...(state.ingest.activeRequestId === undefined
      ? {}
      : { activeRequestId: state.ingest.activeRequestId }),
    loading: state.ingest.loading,
    ...(state.ingest.error === undefined ? {} : { error: state.ingest.error }),
  });
}

function toStoreResult(result: DispatchResult): StoreDispatchResult {
  return result._tag === "Accepted"
    ? { events: result.facts, result }
    : result._tag === "Rejected"
      ? { events: [], rejected: result.rejection.message, result }
      : { events: [], result };
}

async function browserFetchTodos(): Promise<readonly Todo[]> {
  const response = await fetch("https://jsonplaceholder.typicode.com/todos");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as readonly Todo[];
}

/** Creates an isolated Store facade backed by one scoped Cab runtime. @category store @since 0.0.0 */
export function createStore(now: () => string = () => new Date().toISOString()): Store {
  const stateSignal = signal<AppState>(cloneSerializable(initialState));
  const journalSignal = signal<readonly Fact[]>([]);
  const sequenceSignal = signal(0);
  const revisionSignal = signal(0);
  const invocationSignal = signal<readonly CommittedEffectInvocation[]>([]);
  const executionSignal = signal<readonly EffectExecution[]>([]);
  const defectSignal = signal<readonly unknown[]>([]);
  const listeners = new Set<() => void>();
  const committedListeners = new Set<(facts: readonly Fact[]) => void>();
  const deliveredFactIds = new Set<string>();
  const pendingCommitted: Array<readonly Fact[]> = [];
  let deliveringCommitted = false;
  const cache = new Map<string, readonly Todo[]>();
  const adapters: {
    fetchTodos: () => Promise<readonly Todo[]>;
    scrollToAnchor?: (anchor: string, behavior: ScrollBehavior) => void;
  } = { fetchTodos: browserFetchTodos };
  let fallbackNow = 0;

  const adapterLayer = Layer.mergeAll(
    Layer.succeed(TodoApi, {
      list: () =>
        Effect.tryPromise({
          try: (signal) => {
            void signal;
            return adapters.fetchTodos();
          },
          catch: (cause) =>
            new TodoApiError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
    }),
    Layer.succeed(TodoCache, {
      put: (todos: readonly TodoRecord[]) =>
        Effect.try({
          try: () => {
            const copied = cloneSerializable(todos);
            const hash = hashTodos(copied);
            cache.set(hash, copied);
            return hash;
          },
          catch: (cause) => new CacheError({ message: "Unable to cache todos", cause }),
        }),
      get: (hash: string) =>
        Effect.sync(() =>
          Option.fromNullishOr(cache.get(hash)).pipe(
            Option.map((todos) => todos.map((todo) => ({ ...todo }))),
          ),
        ),
    }),
    Layer.succeed(QueryCache, {
      get: (key) => cache.get(key),
      has: (key) => cache.has(key),
    }),
    Layer.succeed(Viewport, {
      scrollTo: (anchor, options) =>
        Effect.try({
          try: () => {
            if (adapters.scrollToAnchor) {
              adapters.scrollToAnchor(anchor, options.behavior);
              return;
            }
            const target = document.querySelector(anchor);
            if (!target || typeof target.scrollIntoView !== "function") {
              throw new TargetNotMounted({ anchor });
            }
            target.scrollIntoView({ behavior: options.behavior, block: options.block });
          },
          catch: () => new TargetNotMounted({ anchor }),
        }),
    }),
    Layer.succeed(RuntimeClock, {
      now: Effect.sync(() => {
        const parsed = Date.parse(now());
        return Number.isFinite(parsed) ? parsed : ++fallbackNow;
      }),
    }),
    Layer.succeed(RuntimeSupervisor, {
      report: (report) =>
        Effect.sync(() => {
          defectSignal([...defectSignal(), report]);
          notify();
          console.error(`Effect defect in ${report.effect} (${report.executionId})`, report.cause);
        }),
    }),
  );
  const dependencies = Layer.mergeAll(
    JournalMemoryLive,
    adapterLayer,
    IdGeneratorLive,
    RenderCoordinatorLive,
  );
  const runtimeLayer = Layer.effect(PocRuntimeService, createPocRuntime()).pipe(
    Layer.provide(dependencies),
  );
  const managed = ManagedRuntime.make(runtimeLayer);
  const runtime = managed.runSync(PocRuntimeService);
  let currentToken: RenderToken = managed.runSync(runtime.snapshot).renderToken;
  let appliedRevision = -1;
  let disposed = false;

  function reportSubscriberDefect(cause: unknown) {
    defectSignal([...defectSignal(), { _tag: "SubscriberDefect", cause }]);
    console.error("Store subscriber defect", cause);
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (cause) {
        reportSubscriberDefect(cause);
      }
    }
  }

  function notifyCommitted(facts: readonly Fact[]) {
    const fresh = facts.filter((fact) => !deliveredFactIds.has(fact.id));
    if (fresh.length === 0) return;
    for (const fact of fresh) deliveredFactIds.add(fact.id);
    pendingCommitted.push(fresh);
    if (deliveringCommitted) return;
    deliveringCommitted = true;
    try {
      while (pendingCommitted.length > 0) {
        const batch = pendingCommitted.shift();
        if (!batch) continue;
        for (const listener of committedListeners) {
          try {
            listener(batch);
          } catch (cause) {
            reportSubscriberDefect(cause);
          }
        }
      }
    } finally {
      deliveringCommitted = false;
    }
  }

  function applySnapshot(snapshot: RuntimeSnapshot<PocState>, facts: readonly Fact[] = []) {
    invocationSignal(snapshot.invocations);
    if (snapshot.revision > appliedRevision) {
      appliedRevision = snapshot.revision;
      stateSignal(flatten(snapshot.state));
      journalSignal(snapshot.journal);
      sequenceSignal(snapshot.sequence);
      revisionSignal(snapshot.revision);
      currentToken = snapshot.renderToken;
      notify();
    }
    notifyCommitted(facts);
  }

  applySnapshot(managed.runSync(runtime.snapshot));

  const revisionFiber: Fiber.Fiber<void, unknown> = managed.runFork(
    Stream.runForEach(runtime.changes, (change) =>
      Effect.gen(function* () {
        const snapshot = yield* runtime.snapshot;
        applySnapshot(snapshot, change.facts);
      }),
    ),
  );
  const executionFiber: Fiber.Fiber<void, unknown> = managed.runFork(
    Stream.runForEach(runtime.executionChanges, (execution) =>
      Effect.gen(function* () {
        const snapshot = yield* runtime.snapshot;
        executionSignal(
          executionSignal().some((item) => item.id === execution.id)
            ? executionSignal().map((item) => (item.id === execution.id ? execution : item))
            : [...executionSignal(), execution],
        );
        invocationSignal(snapshot.invocations);
        notify();
      }),
    ),
  );

  function syncAfter<A>(effect: Effect.Effect<A, unknown>): A {
    const value = managed.runSync(effect);
    applySnapshot(managed.runSync(runtime.snapshot));
    executionSignal(managed.runSync(runtime.executions));
    return value;
  }

  async function applyAfter<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const value = await managed.runPromise(effect);
    applySnapshot(await managed.runPromise(runtime.snapshot));
    executionSignal(await managed.runPromise(runtime.executions));
    return value;
  }

  function typedDispatch<Name extends string, Args>(
    invocation: CommandInvocation<Name, Args>,
    actor: Actor = human,
  ): StoreDispatchResult {
    const result = managed.runSync(runtime.dispatch(invocation, actor));
    executionSignal(managed.runSync(runtime.executions));
    applySnapshot(
      managed.runSync(runtime.snapshot),
      result._tag === "Accepted" ? result.facts : [],
    );
    return toStoreResult(result);
  }

  const description = managed.runSync(runtime.describe);

  return {
    state: stateSignal,
    journal: journalSignal,
    viewingSequence: sequenceSignal,
    isLive: () => sequenceSignal() === journalSignal().length,
    revision: revisionSignal,
    renderToken: () => currentToken,
    invocations: invocationSignal,
    executions: executionSignal,
    defects: defectSignal,
    dispatch: typedDispatch,
    dispatchEffect: (invocation, actor = human) => runtime.dispatch(invocation, actor),
    dispatchUnknown: async (name, args, actor) => {
      const result = await managed.runPromise(runtime.dispatchUnknown(name, args, actor));
      applySnapshot(
        managed.runSync(runtime.snapshot),
        result._tag === "Accepted" ? result.facts : [],
      );
      executionSignal(managed.runSync(runtime.executions));
      return result;
    },
    scrub(sequence) {
      syncAfter(runtime.scrub(sequence));
    },
    async continueFrom() {
      if (!this.isLive()) await applyAfter(runtime.continueFrom(sequenceSignal()));
    },
    live() {
      syncAfter(runtime.live);
    },
    acknowledgeRender(token) {
      managed.runFork(runtime.acknowledgeRender(token));
    },
    replayEffect: (invocationId, allow) =>
      managed.runPromise(
        runtime.replayEffect({ invocationId, rendererId: currentToken.rendererId, allow }),
      ),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCommitted(listener) {
      committedListeners.add(listener);
      return () => committedListeners.delete(listener);
    },
    describe: () => description.commands,
    describeRuntime: () => description,
    configure(next) {
      if (next.fetchTodos) adapters.fetchTodos = next.fetchTodos;
      if (next.scrollToAnchor) adapters.scrollToAnchor = next.scrollToAnchor;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      managed.runFork(Fiber.interrupt(revisionFiber));
      managed.runFork(Fiber.interrupt(executionFiber));
      await managed.dispose();
    },
    todoPayload: (hash) => {
      const todos = cache.get(hash);
      return todos ? cloneSerializable(todos) : undefined;
    },
    cachedPayloadCount: () => cache.size,
  };
}
