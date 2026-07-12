import { Clock, Context, Data, Deferred, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";
import { cloneSerializable } from "./feature.ts";
import type { Actor, RenderToken } from "./model.ts";
import { QueryCache, type ReadonlyQueryCache } from "./query.ts";

/** Is the external todo payload shape kept outside the journal. @category todos @since 0.0.0 */
export interface TodoRecord {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

/** Reports an expected todo API failure. @category errors @since 0.0.0 */
export class TodoApiError extends Data.TaggedError("TodoApiError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Provides external todo reads. @category services @since 0.0.0 */
export class TodoApi extends Context.Service<
  TodoApi,
  { readonly list: () => Effect.Effect<readonly TodoRecord[], TodoApiError> }
>()("cab/TodoApi") {}

/** Reports a payload cache failure. @category errors @since 0.0.0 */
export class CacheError extends Data.TaggedError("CacheError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Provides Effect-owned content-addressed todo payload storage. @category services @since 0.0.0 */
export class TodoCache extends Context.Service<
  TodoCache,
  {
    readonly put: (todos: readonly TodoRecord[]) => Effect.Effect<string, CacheError>;
    readonly get: (hash: string) => Effect.Effect<Option.Option<readonly TodoRecord[]>, CacheError>;
  }
>()("cab/TodoCache") {}

/** Returns the deterministic content hash used by the POC todo cache. @category cache @since 0.0.0 */
export function hashTodos(todos: readonly TodoRecord[]): string {
  const text = JSON.stringify(todos);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `todos-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Creates shared TodoCache and QueryCache layers over one isolated map. @category layers @since 0.0.0 */
export function makeTodoCacheLayers(): Layer.Layer<TodoCache | QueryCache> {
  const values = new Map<string, readonly TodoRecord[]>();
  const queryCache: ReadonlyQueryCache = {
    get: (key) => values.get(key),
    has: (key) => values.has(key),
  };
  const todoCache = {
    put: (todos: readonly TodoRecord[]) =>
      Effect.sync(() => {
        const copied = cloneSerializable(todos);
        const hash = hashTodos(copied);
        values.set(hash, copied);
        return hash;
      }),
    get: (hash: string) =>
      Effect.sync(() => Option.fromNullishOr(values.get(hash))).pipe(
        Effect.map((value) => Option.map(value, (todos) => cloneSerializable(todos))),
      ),
  };
  return Layer.mergeAll(Layer.succeed(TodoCache, todoCache), Layer.succeed(QueryCache, queryCache));
}

/** Builds a deterministic TodoApi layer for tests and previews. @category layers @since 0.0.0 */
export function makeTodoApiLayer(
  list: () => Effect.Effect<readonly TodoRecord[], TodoApiError>,
): Layer.Layer<TodoApi> {
  return Layer.succeed(TodoApi, { list });
}

/** Configures semantic viewport presentation work. @category viewport @since 0.0.0 */
export interface ViewportScrollOptions {
  readonly behavior: "auto" | "smooth";
  readonly block: "center" | "start" | "end" | "nearest";
}

/** Reports that a semantic viewport target is not mounted. @category errors @since 0.0.0 */
export class TargetNotMounted extends Data.TaggedError("TargetNotMounted")<{
  readonly anchor: string;
}> {}

/** Provides the browser-independent viewport effect boundary. @category services @since 0.0.0 */
export class Viewport extends Context.Service<
  Viewport,
  {
    readonly scrollTo: (
      anchor: string,
      options: ViewportScrollOptions,
    ) => Effect.Effect<void, TargetNotMounted>;
  }
>()("cab/Viewport") {}

/** Builds a viewport layer from an explicit test adapter. @category layers @since 0.0.0 */
export function makeViewportLayer(
  scrollTo: (
    anchor: string,
    options: ViewportScrollOptions,
  ) => Effect.Effect<void, TargetNotMounted>,
): Layer.Layer<Viewport> {
  return Layer.succeed(Viewport, { scrollTo });
}

/** Provides stable runtime identifiers. @category services @since 0.0.0 */
export class IdGenerator extends Context.Service<
  IdGenerator,
  { readonly next: (kind: string) => Effect.Effect<string> }
>()("cab/runtime/IdGenerator") {}

/** Supplies process-local monotonic identifiers without browser globals. @category layers @since 0.0.0 */
export const IdGeneratorLive = Layer.sync(IdGenerator, () => {
  let next = 0;
  return { next: (kind: string) => Effect.sync(() => `${kind}-${++next}`) };
});

/** Provides journal timestamp reads at orchestration boundaries. @category services @since 0.0.0 */
export class RuntimeClock extends Context.Service<
  RuntimeClock,
  { readonly now: Effect.Effect<number> }
>()("cab/runtime/Clock") {}

/** Delegates runtime time to Effect's Clock service. @category layers @since 0.0.0 */
export const RuntimeClockLive = Layer.succeed(RuntimeClock, { now: Clock.currentTimeMillis });

/** Reports a superseded or unknown render barrier. @category errors @since 0.0.0 */
export class RenderBarrierError extends Data.TaggedError("RenderBarrierError")<{
  readonly reason: "superseded" | "unknown-token";
  readonly token: RenderToken;
}> {}

/** Coordinates exact render publication and acknowledgement barriers. @category services @since 0.0.0 */
export class RenderCoordinator extends Context.Service<
  RenderCoordinator,
  {
    readonly published: Stream.Stream<RenderToken>;
    readonly publish: (token: RenderToken) => Effect.Effect<void>;
    readonly acknowledge: (token: RenderToken) => Effect.Effect<void>;
    readonly await: (token: RenderToken) => Effect.Effect<void, RenderBarrierError>;
    readonly isAcknowledged: (token: RenderToken) => Effect.Effect<boolean>;
  }
>()("cab/runtime/RenderCoordinator") {}

function tokenKey(token: RenderToken): string {
  return `${token.rendererId}:${token.revision}:${token.sequence}:${token.mode}`;
}

interface RenderBarrier {
  readonly token: RenderToken;
  readonly deferred: Deferred.Deferred<void, RenderBarrierError>;
  acknowledged: boolean;
}

/** Creates the in-memory render coordinator layer. @category layers @since 0.0.0 */
export function makeRenderCoordinatorLayer(): Layer.Layer<RenderCoordinator> {
  return Layer.effect(
    RenderCoordinator,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<RenderToken>();
      const barriers = new Map<string, RenderBarrier>();
      return {
        published: Stream.fromPubSub(pubsub),
        publish: (token: RenderToken) =>
          Effect.gen(function* () {
            for (const [key, barrier] of barriers) {
              if (
                barrier.token.rendererId === token.rendererId &&
                !barrier.acknowledged &&
                key !== tokenKey(token)
              ) {
                yield* Deferred.fail(
                  barrier.deferred,
                  new RenderBarrierError({ reason: "superseded", token: barrier.token }),
                );
                barriers.delete(key);
              }
            }
            barriers.set(tokenKey(token), {
              token,
              deferred: Deferred.makeUnsafe<void, RenderBarrierError>(),
              acknowledged: false,
            });
            yield* PubSub.publish(pubsub, token);
          }),
        acknowledge: (token: RenderToken) =>
          Effect.gen(function* () {
            const barrier = barriers.get(tokenKey(token));
            if (!barrier) return;
            barrier.acknowledged = true;
            yield* Deferred.succeed(barrier.deferred, undefined);
          }),
        await: (token: RenderToken) => {
          const barrier = barriers.get(tokenKey(token));
          return barrier
            ? Deferred.await(barrier.deferred)
            : Effect.fail(new RenderBarrierError({ reason: "unknown-token", token }));
        },
        isAcknowledged: (token: RenderToken) =>
          Effect.sync(() => barriers.get(tokenKey(token))?.acknowledged === true),
      };
    }),
  );
}

/** Supplies a single-renderer in-memory render coordinator. @category layers @since 0.0.0 */
export const RenderCoordinatorLive = makeRenderCoordinatorLayer();

/** Describes an Effect defect delivered to runtime supervision. @category telemetry @since 0.0.0 */
export interface SupervisorReport {
  readonly executionId: string;
  readonly effect: string;
  readonly cause: unknown;
  readonly actor: Actor;
}

/** Receives execution defects without fabricating domain facts. @category services @since 0.0.0 */
export class RuntimeSupervisor extends Context.Service<
  RuntimeSupervisor,
  { readonly report: (report: SupervisorReport) => Effect.Effect<void> }
>()("cab/runtime/Supervisor") {}

/** Drops supervised defects after telemetry records them. @category layers @since 0.0.0 */
export const RuntimeSupervisorLive = Layer.succeed(RuntimeSupervisor, {
  report: () => Effect.void,
});

/** Builds an inspectable supervisor layer for tests. @category layers @since 0.0.0 */
export function makeRuntimeSupervisorLayer(): {
  readonly layer: Layer.Layer<RuntimeSupervisor>;
  readonly reports: Effect.Effect<readonly SupervisorReport[]>;
} {
  const ref = Ref.makeUnsafe<readonly SupervisorReport[]>([]);
  return {
    layer: Layer.succeed(RuntimeSupervisor, {
      report: (report) => Ref.update(ref, (reports) => [...reports, report]),
    }),
    reports: Ref.get(ref),
  };
}
