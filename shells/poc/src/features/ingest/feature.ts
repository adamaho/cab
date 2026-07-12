import { Effect, Schema } from "effect";
import { Decision } from "../../runtime/decision.ts";
import { defineCommand, defineEffect, defineEvent } from "../../runtime/definition.ts";
import { defineFeature } from "../../runtime/feature.ts";
import { CacheError, TodoApi, TodoApiError, TodoCache } from "../../runtime/services.ts";

/** Is the ingest feature's folded state and stable request fence. @category ingest @since 0.0.0 */
export interface IngestState {
  readonly loading: boolean;
  readonly activeRequestId?: string;
  readonly requestHash?: string;
  readonly count?: number;
  readonly error?: string;
}

const RequestArgs = Schema.Struct({ requestId: Schema.String });

/** Records user or agent intent to refresh todos. @category ingest-events @since 0.0.0 */
export const RefreshRequested = defineEvent({
  name: "RefreshRequested",
  version: 1,
  schema: RequestArgs,
  scope: "session",
  retention: "permanent",
  render: () => "requested fresh todos",
});

/** Records a content-addressed successful refresh outcome. @category ingest-events @since 0.0.0 */
export const RefreshCompleted = defineEvent({
  name: "RefreshCompleted",
  version: 1,
  schema: Schema.Struct({
    requestId: Schema.String,
    requestHash: Schema.String,
    count: Schema.Number,
  }),
  scope: "session",
  retention: "permanent",
  render: (args) => `loaded ${args.count} todos`,
});

/** Records an expected refresh failure. @category ingest-events @since 0.0.0 */
export const RefreshFailed = defineEvent({
  name: "RefreshFailed",
  version: 1,
  schema: Schema.Struct({ requestId: Schema.String, message: Schema.String }),
  scope: "session",
  retention: "permanent",
  render: (args) => `failed to refresh todos: ${args.message}`,
});

/** Fetches and content-addresses todos after RefreshRequested commits. @category ingest-effects @since 0.0.0 */
export const FetchTodos = defineEffect<
  "todos.fetch",
  { readonly requestId: string },
  { readonly requestId: string; readonly requestHash: string; readonly count: number },
  TodoApiError | CacheError | import("../../runtime/definition.ts").StaleExecution,
  TodoApi | TodoCache
>({
  name: "todos.fetch",
  version: 1,
  description: "Fetch todos and cache the content-addressed payload",
  args: RequestArgs,
  phase: "after-commit",
  replay: "never",
  authority: "client",
  concurrency: { _tag: "Latest", key: () => "todos.refresh" },
  run: ({ requestId }, context) =>
    Effect.gen(function* () {
      const api = yield* TodoApi;
      const cache = yield* TodoCache;
      const todos = yield* api.list();
      yield* context.ensureCurrent;
      const requestHash = yield* cache.put(todos);
      return { requestId, requestHash, count: todos.length };
    }),
  onSuccess: (result) => completeTodosRefresh.make(result),
  onFailure: (error, { requestId }) => failTodosRefresh.make({ requestId, message: error.message }),
});

/** Requests fresh todos and selects the todos.fetch effect. @category ingest-commands @since 0.0.0 */
export const refreshTodos = defineCommand<"todos.refresh", Record<string, never>, IngestState>({
  name: "todos.refresh",
  description: "Request fresh todos",
  args: Schema.Struct({}),
  exposure: "public",
  possibleEffects: [FetchTodos.name],
  decide: ({ state, command }) =>
    state.loading
      ? Decision.reject("todos.refresh.already-running", "A refresh is already running")
      : Decision.accept({
          events: [RefreshRequested.make({ requestId: command.id })],
          effects: [FetchTodos.make({ requestId: command.id })],
        }),
});

/** Commits a fenced successful fetch result from the runtime. @category ingest-commands @since 0.0.0 */
export const completeTodosRefresh = defineCommand<
  "todos.completeRefresh",
  { readonly requestId: string; readonly requestHash: string; readonly count: number },
  IngestState
>({
  name: "todos.completeRefresh",
  description: "Record a successful todo fetch reference",
  args: RefreshCompleted.schema,
  exposure: "outcome",
  decide: ({ state }, args) =>
    state.loading && state.activeRequestId === args.requestId
      ? Decision.accept({ events: [RefreshCompleted.make(args)] })
      : Decision.reject("todos.refresh.stale", "The refresh request is no longer pending"),
});

/** Commits a fenced expected fetch failure from the runtime. @category ingest-commands @since 0.0.0 */
export const failTodosRefresh = defineCommand<
  "todos.failRefresh",
  { readonly requestId: string; readonly message: string },
  IngestState
>({
  name: "todos.failRefresh",
  description: "Record a failed todo fetch",
  args: RefreshFailed.schema,
  exposure: "outcome",
  decide: ({ state }, args) =>
    state.loading && state.activeRequestId === args.requestId
      ? Decision.accept({ events: [RefreshFailed.make(args)] })
      : Decision.reject("todos.refresh.stale", "The refresh request is no longer pending"),
});

/** Composes todo ingest state, outcomes, and external work. @category ingest @since 0.0.0 */
export const ingestFeature = defineFeature<"ingest", IngestState, TodoApi | TodoCache>({
  name: "ingest",
  initialState: { loading: false } satisfies IngestState,
  events: [RefreshRequested, RefreshCompleted, RefreshFailed],
  commands: [refreshTodos, completeTodosRefresh, failTodosRefresh],
  effects: [FetchTodos],
  reduce: (state: IngestState, fact) => {
    if (fact.name === RefreshRequested.name) {
      const { error: _error, ...rest } = state;
      return {
        ...rest,
        loading: true,
        activeRequestId: (fact.args as { readonly requestId: string }).requestId,
      };
    }
    if (fact.name === RefreshCompleted.name) {
      const args = fact.args as {
        readonly requestHash: string;
        readonly count: number;
      };
      const { activeRequestId: _activeRequestId, error: _error, ...rest } = state;
      return { ...rest, loading: false, requestHash: args.requestHash, count: args.count };
    }
    if (fact.name === RefreshFailed.name) {
      const args = fact.args as { readonly message: string };
      const { activeRequestId: _activeRequestId, ...rest } = state;
      return { ...rest, loading: false, error: args.message };
    }
    return state;
  },
});
