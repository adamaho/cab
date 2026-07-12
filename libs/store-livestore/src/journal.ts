import type { Actor } from "./actor.ts";

// -- Types

/**
 * Minimal structural surface of a store that exposes its event stream.
 *
 * @category models
 * @since 0.0.0
 */
export interface JournalSource {
  events(): AsyncIterable<{
    readonly name: string;
    readonly args: unknown;
    readonly seqNum: { readonly global: number; readonly client: number };
    readonly clientId: string;
    readonly sessionId: string;
  }>;
}

/**
 * One observed journal fact: the decoded event plus LiveStore metadata.
 *
 * @category models
 * @since 0.0.0
 */
export interface JournalFact {
  readonly name: string;
  readonly args: unknown;
  readonly seqNum: { readonly global: number; readonly client: number };
  readonly clientId: string;
  readonly sessionId: string;
}

/**
 * Live journal projection over a store.
 *
 * **Details**
 *
 * This is the seam where derived consumers of history plug in — devtools,
 * persistence mirrors, and semantic (vector) indexes all consume the same
 * ordered facts. `facts()` snapshots what has been observed so far;
 * `onFact` registers a synchronous listener for new facts.
 *
 * **Gotchas**
 *
 * LiveStore 0.4 streams only backend-confirmed events through
 * `store.events()`, so a store without a sync backend never surfaces facts
 * here, and confirmed facts arrive asynchronously after commit. Local
 * unconfirmed-event streaming is on LiveStore's roadmap.
 *
 * @category models
 * @since 0.0.0
 */
export interface Journal {
  readonly facts: () => ReadonlyArray<JournalFact>;
  readonly onFact: (listener: (fact: JournalFact) => void) => () => void;
  /** Resolves once at least `count` facts have been observed. */
  readonly waitForFacts: (count: number, timeoutMs?: number) => Promise<ReadonlyArray<JournalFact>>;
}

// -- Constructors

/**
 * Attaches a live journal projection to a store's event stream.
 *
 * @category constructors
 * @since 0.0.0
 */
export function attachJournal(store: JournalSource): Journal {
  const facts: Array<JournalFact> = [];
  const listeners = new Set<(fact: JournalFact) => void>();
  const waiters = new Set<() => void>();

  void (async () => {
    try {
      for await (const event of store.events()) {
        const fact: JournalFact = {
          name: event.name,
          args: event.args,
          seqNum: { global: event.seqNum.global, client: event.seqNum.client },
          clientId: event.clientId,
          sessionId: event.sessionId,
        };

        facts.push(fact);

        for (const listener of listeners) {
          listener(fact);
        }

        for (const waiter of waiters) {
          waiter();
        }
      }
    } catch {
      // The stream ends when the store shuts down.
    }
  })();

  return {
    facts: () => [...facts],
    onFact: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    waitForFacts: (count, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        function check(): void {
          if (facts.length >= count) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve([...facts]);
          }
        }
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(`Timed out waiting for ${count} journal facts; observed ${facts.length}`),
          );
        }, timeoutMs);

        waiters.add(check);
        check();
      }),
  };
}

// -- Rendering

type RenderableArgs = Record<string, unknown> & { readonly actor: Actor };

function actorLabel(actor: Actor): string {
  return `${actor.kind === "human" ? "Human" : "Agent"} ${actor.id}`;
}

/**
 * Renders one journal fact as a plain-language sentence.
 *
 * **Details**
 *
 * This rendering is the hook for semantic journal indexing: sentences — not
 * raw event JSON — are what an embedding model can retrieve against. A vector
 * index would consume `journal.onFact`, render, embed, and store alongside the
 * fact's sequence number so semantic lookups can jump back into history.
 *
 * @category rendering
 * @since 0.0.0
 */
export function renderFact(fact: JournalFact): string {
  const args = fact.args as RenderableArgs;
  const who = actorLabel(args.actor);

  switch (fact.name) {
    case "v1.InvoiceAdded":
      return `${who} added invoice ${String(args["id"])} from ${String(args["vendor"])} for $${String(args["amount"])} (${String(args["status"])})`;
    case "v1.InvoiceStatusChanged":
      return `${who} moved invoice ${String(args["id"])} to ${String(args["status"])}`;
    case "v1.FilterApplied":
      return args["value"] === null
        ? `${who} cleared the ${String(args["field"])} filter`
        : `${who} filtered invoices by ${String(args["field"])} = ${String(args["value"])}`;
    default:
      return `${who} committed ${fact.name}`;
  }
}
