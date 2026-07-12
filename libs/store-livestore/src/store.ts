import { makeAdapter } from "@livestore/adapter-node";
import type { SyncOptions } from "@livestore/common";
import { createStorePromise, type Store } from "@livestore/livestore";

import { createDispatcher, type CommandDescription, type Dispatcher } from "./command.ts";
import { commands, schema } from "./invoices.ts";
import { attachJournal, type Journal } from "./journal.ts";

/**
 * Concrete store type for the invoice board schema.
 *
 * @category models
 * @since 0.0.0
 */
export type InvoiceBoardStore = Store<typeof schema>;

// -- Types

/**
 * Options for constructing one invoice-board client.
 *
 * @category models
 * @since 0.0.0
 */
export interface InvoiceStoreOptions {
  /** Shared identity of the synced store; clients with equal ids sync. */
  readonly storeId: string;
  /** Device identity; defaults to the machine hostname. */
  readonly clientId?: string;
  /** Session identity within the client; defaults to "static". */
  readonly sessionId?: string;
  /** Optional sync backend; omit for a local-only store. */
  readonly syncBackend?: SyncOptions["backend"];
}

/**
 * A fully wired invoice-board client: store, commands, and journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface InvoiceStore {
  readonly store: InvoiceBoardStore;
  readonly journal: Journal;
  readonly dispatch: Dispatcher<typeof commands>["dispatch"];
  readonly describeCommands: () => ReadonlyArray<CommandDescription>;
  readonly shutdown: () => Promise<void>;
}

// -- Constructors

/**
 * Builds one in-memory invoice-board client over LiveStore.
 *
 * **Details**
 *
 * Uses the single-threaded node adapter with in-memory storage. Pass the same
 * `storeId` and a shared sync backend to simulate multiple collaborating
 * clients (for example one human client and one agent client).
 *
 * @category constructors
 * @since 0.0.0
 */
export async function makeInvoiceStore(options: InvoiceStoreOptions): Promise<InvoiceStore> {
  const adapter = makeAdapter({
    storage: { type: "in-memory" },
    ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.syncBackend === undefined
      ? {}
      : { sync: { backend: options.syncBackend, onSyncError: "shutdown" as const } }),
  });

  const store = await createStorePromise({
    schema,
    adapter,
    storeId: options.storeId,
  });

  const journal = attachJournal(store);
  const dispatcher = createDispatcher(store, commands);

  return {
    store,
    journal,
    dispatch: dispatcher.dispatch,
    describeCommands: dispatcher.describe,
    shutdown: () => store.shutdownPromise(),
  };
}
