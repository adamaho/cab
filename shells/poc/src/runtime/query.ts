import { Context, Effect, Layer } from "effect";

/** Gives pure queries read-only access to folded state and cached payloads. @category queries @since 0.0.0 */
export interface QueryContext {
  readonly state: unknown;
  readonly cache: ReadonlyQueryCache;
}

/** Is a reusable pure projection over folded state and the cache seam. @category queries @since 0.0.0 */
export interface Query<A> {
  readonly _tag: "Query";
  readonly run: (context: QueryContext) => A;
}

/** Creates a named-independent pure query value. @category queries @since 0.0.0 */
export function defineQuery<A>(run: (context: QueryContext) => A): Query<A> {
  return { _tag: "Query", run };
}

/** Is the synchronous read-only cache capability available to pure queries. @category queries @since 0.0.0 */
export interface ReadonlyQueryCache {
  readonly get: (key: string) => unknown;
  readonly has: (key: string) => boolean;
}

/** Supplies the cache snapshot seam used by decisions and runtime queries. @category services @since 0.0.0 */
export class QueryCache extends Context.Service<QueryCache, ReadonlyQueryCache>()(
  "cab/runtime/QueryCache",
) {}

const emptyQueryCache: ReadonlyQueryCache = {
  get: () => undefined,
  has: () => false,
};

/** Supplies an empty cache for runtimes without external payload queries. @category layers @since 0.0.0 */
export const QueryCacheEmpty = Layer.succeed(QueryCache, emptyQueryCache);

/** Evaluates a pure query against an explicit state and cache seam. @category queries @since 0.0.0 */
export function runQuery<A>(query: Query<A>, state: unknown, cache: ReadonlyQueryCache): A {
  return query.run({ state, cache });
}

/** Reads a query through the configured cache service. @category queries @since 0.0.0 */
export function queryEffect<A>(
  query: Query<A>,
  state: unknown,
): Effect.Effect<A, never, QueryCache> {
  return Effect.gen(function* () {
    const cache = yield* QueryCache;
    return runQuery(query, state, cache);
  });
}
