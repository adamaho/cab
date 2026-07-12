import { deepEqual } from "@livestore/livestore";

// -- Types

/**
 * Minimal structural surface of a store that supports callback subscriptions.
 *
 * @category models
 * @since 0.0.0
 */
export interface SubscribeSource {
  // oxlint-disable-next-line no-explicit-any
  subscribe(query: object, onUpdate: (value: any) => void): () => void;
}

// -- Subscriptions

/**
 * Subscribes to a query and notifies only when the result value changes.
 *
 * **Details**
 *
 * Measured LiveStore behavior: a query subscriber is re-notified on every
 * write to any table the query reads, even when the query result is
 * value-identical. That granularity is too coarse for cab's requirement that
 * a row subscriber never re-renders for unrelated row changes. This helper
 * layers a deep-equality cutoff over `store.subscribe`, restoring change-only
 * notification at the subscriber boundary. The query still re-runs per table
 * write; only notification is deduplicated.
 *
 * @category subscriptions
 * @since 0.0.0
 */
export function subscribeDistinct<TResult>(
  store: SubscribeSource,
  query: object,
  onUpdate: (result: TResult) => void,
): () => void {
  let initialized = false;
  let previous: TResult;

  return store.subscribe(query, (result: TResult) => {
    if (initialized && deepEqual(previous, result)) {
      return;
    }

    initialized = true;
    previous = result;
    onUpdate(result);
  });
}
