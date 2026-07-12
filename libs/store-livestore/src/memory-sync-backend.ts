import { SyncBackend, validatePushPayload, type SyncOptions } from "@livestore/common";
import { EventSequenceNumber, type LiveStoreEvent } from "@livestore/livestore";
import { Effect, Option, PubSub, Ref, Stream, SubscriptionRef } from "effect";

// -- Types

type GlobalEvent = LiveStoreEvent.Global.Encoded;

/**
 * Shared in-memory sync backend serving any number of clients.
 *
 * @category models
 * @since 0.0.0
 */
export interface MemorySyncBackend {
  /** Per-client backend constructor; pass as `syncBackend` to each client. */
  readonly backend: SyncOptions["backend"];
  /** Snapshot of every event the backend has accepted, in global order. */
  readonly events: () => ReadonlyArray<GlobalEvent>;
}

// -- Constructors

/**
 * Builds a multi-client in-memory sync backend.
 *
 * **Details**
 *
 * LiveStore's own `makeMockSyncBackend` delivers live pulls through a single
 * queue, so with more than one subscribed client each event reaches only one
 * of them. This backend broadcasts through a pub/sub hub instead, giving every
 * client the full global event order — enough to simulate human-and-agent
 * multiplayer entirely in memory.
 *
 * @category constructors
 * @since 0.0.0
 */
export function makeMemorySyncBackend(): MemorySyncBackend {
  const root = Number(EventSequenceNumber.Client.ROOT.global);
  const eventsRef = Ref.unsafeMake<ReadonlyArray<GlobalEvent>>([]);
  const headRef = Ref.unsafeMake(EventSequenceNumber.Client.ROOT.global);
  const hub = Effect.runSync(PubSub.unbounded<GlobalEvent>());

  function toItem(batch: ReadonlyArray<GlobalEvent>) {
    return {
      batch: batch.map((eventEncoded) => ({ eventEncoded, metadata: Option.none() })),
      pageInfo: SyncBackend.pageInfoNoMore,
    };
  }

  function backend(): ReturnType<NonNullable<SyncOptions["backend"]>> {
    return Effect.gen(function* () {
      const isConnected = yield* SubscriptionRef.make(true);

      return SyncBackend.of({
        connect: Effect.void,
        ping: Effect.void,
        isConnected,
        metadata: {
          name: "cab-memory-sync-backend",
          description: "In-memory multi-client sync backend for cab prototypes and tests.",
        },
        supports: { pullPageInfoKnown: true, pullLive: true },
        pull: (cursor, options) => {
          const since = Option.match(cursor, {
            onNone: () => root,
            onSome: (value) => Number(value.eventSequenceNumber),
          });

          if (options?.live === true) {
            return Stream.unwrapScoped(
              Effect.gen(function* () {
                // Subscribe before reading the backlog so no event can fall
                // between snapshot and subscription; the monotonic global
                // sequence deduplicates the overlap.
                const subscription = yield* PubSub.subscribe(hub);
                const backlog = (yield* Ref.get(eventsRef)).filter(
                  (event) => Number(event.seqNum) > since,
                );
                let emitted =
                  backlog.length > 0 ? Number(backlog[backlog.length - 1]?.seqNum) : since;

                const live = Stream.fromQueue(subscription).pipe(
                  Stream.filter((event) => Number(event.seqNum) > emitted),
                  Stream.map((event) => {
                    emitted = Number(event.seqNum);

                    return toItem([event]);
                  }),
                );

                return Stream.concat(Stream.make(toItem(backlog)), live);
              }),
            );
          }

          return Stream.fromEffect(
            Ref.get(eventsRef).pipe(
              Effect.map((all) => toItem(all.filter((event) => Number(event.seqNum) > since))),
            ),
          );
        },
        push: (batch) =>
          Effect.gen(function* () {
            const head = yield* Ref.get(headRef);

            yield* validatePushPayload(batch, head);
            yield* Ref.update(eventsRef, (all) => [...all, ...batch]);

            const last = batch[batch.length - 1];

            if (last !== undefined) {
              yield* Ref.set(headRef, last.seqNum);
            }

            yield* PubSub.publishAll(hub, batch);
          }),
      });
    });
  }

  return {
    backend,
    events: () => Effect.runSync(Ref.get(eventsRef)),
  };
}
