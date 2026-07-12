import { describe, expect, it, vi } from "vitest";

import {
  makeInvoiceStore,
  makeMemorySyncBackend,
  renderFact,
  subscribeDistinct,
  tables,
  type Actor,
  type InvoiceStore,
} from "../src/index.ts";

const human: Actor = { kind: "human", id: "adam" };
const agent: Actor = { kind: "agent", id: "claude" };

let storeCounter = 0;

function nextStoreId(): string {
  storeCounter += 1;

  return `prototype-${storeCounter}`;
}

async function withStore(
  run: (store: InvoiceStore) => Promise<void>,
  options?: { readonly storeId?: string },
): Promise<void> {
  const store = await makeInvoiceStore({ storeId: options?.storeId ?? nextStoreId() });

  try {
    await run(store);
  } finally {
    await store.shutdown();
  }
}

describe("command layer", () => {
  it("validates args, decides against state, and rejects with actionable reasons", () =>
    withStore(async (board) => {
      const added = board.dispatch(
        "addInvoice",
        { id: "inv-1", vendor: "Acme", amount: 120 },
        human,
      );

      expect(added.rejected).toBeUndefined();
      expect(added.events).toHaveLength(1);

      const duplicate = board.dispatch(
        "addInvoice",
        { id: "inv-1", vendor: "Acme", amount: 120 },
        human,
      );

      expect(duplicate.events).toHaveLength(0);
      expect(duplicate.rejected).toBeUndefined();

      const negative = board.dispatch(
        "addInvoice",
        { id: "inv-2", vendor: "Acme", amount: -5 },
        human,
      );

      expect(negative.rejected).toMatch(/amount must be positive/);

      const invalidTransition = board.dispatch(
        "changeInvoiceStatus",
        { id: "inv-1", status: "paid" },
        agent,
      );

      expect(invalidTransition.rejected).toMatch(/from "draft" to "paid"/);
      expect(invalidTransition.rejected).toMatch(/allowed: sent/);

      const rows = board.store.query(tables.invoices.select()) as ReadonlyArray<{
        id: string;
        status: string;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("draft");
    }));

  // The journal projection consumes `store.events()`, which LiveStore 0.4
  // only feeds with backend-confirmed events — hence the sync backend here.
  it("stamps every journal fact with domain actor and device provenance", async () => {
    const sync = makeMemorySyncBackend();
    const board = await makeInvoiceStore({
      storeId: nextStoreId(),
      clientId: "human-laptop",
      syncBackend: sync.backend,
    });

    try {
      board.dispatch("addInvoice", { id: "inv-1", vendor: "Acme", amount: 120 }, human);
      board.dispatch("applyFilter", { field: "status", value: "draft" }, agent);

      const facts = await board.journal.waitForFacts(2);

      expect(facts).toHaveLength(2);
      expect((facts[0]?.args as { actor: Actor } | undefined)?.actor).toEqual(human);
      expect((facts[1]?.args as { actor: Actor } | undefined)?.actor).toEqual(agent);

      for (const fact of facts) {
        expect(fact.clientId).toBe("human-laptop");
        expect(fact.sessionId).toBeTruthy();
        expect(fact.seqNum.global).toBeGreaterThanOrEqual(0);
      }

      expect(renderFact(facts[0]!)).toBe(
        "Human adam added invoice inv-1 from Acme for $120 (draft)",
      );
      expect(renderFact(facts[1]!)).toBe("Agent claude filtered invoices by status = draft");
    } finally {
      await board.shutdown();
    }
  });

  it("describes every command with a JSON Schema for agent discovery", () =>
    withStore(async (board) => {
      const described = board.describeCommands();
      const names = described.map((command) => command.name).sort();

      expect(names).toEqual([
        "addInvoice",
        "applyFilter",
        "changeInvoiceStatus",
        "undoLastFilterChangeBy",
      ]);

      for (const command of described) {
        expect(command.description.length).toBeGreaterThan(20);
        expect(JSON.stringify(command.argsSchema)).toContain("properties");
      }

      const applyFilter = described.find((command) => command.name === "applyFilter");

      expect(JSON.stringify(applyFilter?.argsSchema)).toContain("status");
    }));
});

describe("fine-grained reactivity", () => {
  // Measured LiveStore 0.4 semantics, kept as a regression pin: subscription
  // callbacks fire synchronously, cross-table isolation holds, but a raw
  // subscriber is re-notified for every write to a table its query reads —
  // even when the query result is value-identical.
  it("raw subscribers are per-table: unrelated same-table writes re-notify", () =>
    withStore(async (board) => {
      board.dispatch("addInvoice", { id: "inv-a", vendor: "Acme", amount: 100 }, human);

      const rowA = vi.fn();
      const filters = vi.fn();
      const unsubscribeRowA = board.store.subscribe(tables.invoices.where({ id: "inv-a" }), rowA);
      const unsubscribeFilters = board.store.subscribe(tables.filters.select(), filters);

      // The initial result is delivered synchronously on subscribe.
      expect(rowA).toHaveBeenCalledTimes(1);

      // Same-table, unrelated row: re-notified with an identical result.
      board.dispatch("addInvoice", { id: "inv-b", vendor: "Globex", amount: 200 }, agent);

      expect(rowA).toHaveBeenCalledTimes(2);
      expect(rowA.mock.calls[1]).toEqual(rowA.mock.calls[0]);

      // Different table: not notified.
      expect(filters).toHaveBeenCalledTimes(1);

      board.dispatch("applyFilter", { field: "status", value: "sent" }, agent);

      expect(filters).toHaveBeenCalledTimes(2);
      expect(rowA).toHaveBeenCalledTimes(2);

      unsubscribeRowA();
      unsubscribeFilters();
    }));

  // The cab layer restores the granularity the mission needs: a row
  // subscriber never fires for unrelated row changes.
  it("subscribeDistinct notifies only when the selected value changes", () =>
    withStore(async (board) => {
      board.dispatch("addInvoice", { id: "inv-a", vendor: "Acme", amount: 100 }, human);

      const rowA = vi.fn();
      const unsubscribe = subscribeDistinct(
        board.store,
        tables.invoices.where({ id: "inv-a" }),
        rowA,
      );

      expect(rowA).toHaveBeenCalledTimes(1);

      // Unrelated row changes in the same table: no notification.
      board.dispatch("addInvoice", { id: "inv-b", vendor: "Globex", amount: 200 }, agent);
      board.dispatch("changeInvoiceStatus", { id: "inv-b", status: "sent" }, agent);

      expect(rowA).toHaveBeenCalledTimes(1);

      // Related change: exactly one notification with the new value.
      board.dispatch("changeInvoiceStatus", { id: "inv-a", status: "sent" }, human);

      expect(rowA).toHaveBeenCalledTimes(2);

      const lastResult = rowA.mock.calls[1]?.[0] as ReadonlyArray<{ status: string }> | undefined;

      expect(lastResult?.[0]?.status).toBe("sent");

      unsubscribe();
    }));
});

describe("history and compensation", () => {
  it("undoes the agent's last filter change as a new attributed fact", () =>
    withStore(async (board) => {
      board.dispatch("applyFilter", { field: "status", value: "overdue" }, human);
      board.dispatch("applyFilter", { field: "status", value: "paid" }, agent);

      const undone = board.dispatch("undoLastFilterChangeBy", { kind: "agent" }, human);

      expect(undone.rejected).toBeUndefined();
      expect(undone.events).toHaveLength(1);

      const filterRows = board.store.query(tables.filters.select()) as ReadonlyArray<{
        field: string;
        value: string | null;
        appliedByKind: string;
      }>;

      expect(filterRows).toHaveLength(1);
      expect(filterRows[0]?.value).toBe("overdue");
      // The restore is attributed to the human who asked for it.
      expect(filterRows[0]?.appliedByKind).toBe("human");

      // History is compensated, never rewritten: all three changes remain.
      const history = board.store.query(tables.filterHistory.select()) as ReadonlyArray<{
        value: string | null;
      }>;

      expect(history).toHaveLength(3);
      expect(history.map((row) => row.value).sort()).toEqual(["overdue", "overdue", "paid"]);

      const rejected = board.dispatch("undoLastFilterChangeBy", { kind: "agent" }, human);

      expect(rejected.rejected).toBeUndefined();
      // Undoing again is a no-op: the agent's last change is already compensated.
      expect(rejected.events).toHaveLength(0);
    }));

  it("rejects an undo when the actor kind never changed a filter", () =>
    withStore(async (board) => {
      const result = board.dispatch("undoLastFilterChangeBy", { kind: "agent" }, human);

      expect(result.rejected).toMatch(/no filter changes by any agent/);
    }));
});

describe("multiplayer sync", () => {
  it("converges a human client and an agent client through a shared backend with provenance intact", async () => {
    const sync = makeMemorySyncBackend();
    const storeId = nextStoreId();

    const humanClient = await makeInvoiceStore({
      storeId,
      clientId: "human-laptop",
      sessionId: "human-session",
      syncBackend: sync.backend,
    });
    const agentClient = await makeInvoiceStore({
      storeId,
      clientId: "agent-runtime",
      sessionId: "agent-session",
      syncBackend: sync.backend,
    });

    try {
      humanClient.dispatch("addInvoice", { id: "inv-1", vendor: "Acme", amount: 120 }, human);

      await vi.waitFor(
        () => {
          const invoicesOnAgent = agentClient.store.query(
            tables.invoices.select(),
          ) as ReadonlyArray<unknown>;

          expect(invoicesOnAgent).toHaveLength(1);
        },
        { timeout: 10_000, interval: 50 },
      );

      agentClient.dispatch("applyFilter", { field: "vendor", value: "Acme" }, agent);

      await vi.waitFor(
        () => {
          const filtersOnHuman = humanClient.store.query(
            tables.filters.select(),
          ) as ReadonlyArray<unknown>;

          expect(filtersOnHuman).toHaveLength(1);
        },
        { timeout: 10_000, interval: 50 },
      );

      // Both clients converge on identical state.
      const humanFilters = humanClient.store.query(tables.filters.select());
      const agentFilters = agentClient.store.query(tables.filters.select());

      expect(humanFilters).toEqual(agentFilters);

      // The human's fact arrived on the agent client with domain and device
      // provenance intact.
      const agentJournal = await agentClient.journal.waitForFacts(2);
      const invoiceFact = agentJournal.find((fact) => fact.name === "v1.InvoiceAdded");

      expect(invoiceFact).toBeDefined();
      expect((invoiceFact?.args as { actor: Actor } | undefined)?.actor).toEqual(human);
      expect(invoiceFact?.clientId).toBe("human-laptop");

      // Cross-client history-aware command: the human undoes the agent's
      // filter after it synced.
      const undone = humanClient.dispatch("undoLastFilterChangeBy", { kind: "agent" }, human);

      expect(undone.events).toHaveLength(1);

      await vi.waitFor(
        () => {
          const filtersOnAgent = agentClient.store.query(tables.filters.select()) as ReadonlyArray<{
            value: string | null;
          }>;

          expect(filtersOnAgent[0]?.value).toBeNull();
        },
        { timeout: 10_000, interval: 50 },
      );
      // The backend saw every fact in one global order.
      expect(sync.events().length).toBeGreaterThanOrEqual(3);
    } finally {
      await humanClient.shutdown();
      await agentClient.shutdown();
    }
  }, 30_000);

  // Pinned LiveStore 0.4.0 finding (deterministic in our probes): when two
  // clients' first pushes race, the losing client rebases (rebaseGeneration
  // bumps) and pushes correctly — the backend log and the winning client
  // converge — but the rebasing client's *materialized state* is missing the
  // upstream event while its syncStatus reports isSynced: true. If this test
  // starts passing, LiveStore fixed the rebase path: remove `.fails` and fold
  // it into the convergence test above.
  it.fails("concurrent first pushes materialize upstream events on the rebasing client", async () => {
    const sync = makeMemorySyncBackend();
    const storeId = nextStoreId();

    const humanClient = await makeInvoiceStore({
      storeId,
      clientId: "human-laptop",
      syncBackend: sync.backend,
    });
    const agentClient = await makeInvoiceStore({
      storeId,
      clientId: "agent-runtime",
      syncBackend: sync.backend,
    });

    try {
      // Same tick: both clients optimistically assign the same global
      // sequence to their first event, forcing one of them to rebase.
      humanClient.dispatch("addInvoice", { id: "inv-1", vendor: "Acme", amount: 120 }, human);
      agentClient.dispatch("applyFilter", { field: "vendor", value: "Acme" }, agent);

      await vi.waitFor(
        () => {
          expect(sync.events()).toHaveLength(2);
          expect(humanClient.store.syncStatus().isSynced).toBe(true);
          expect(agentClient.store.syncStatus().isSynced).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );

      // Both clients must see both facts; today the rebasing client is
      // missing the other client's row.
      const invoicesOnAgent = agentClient.store.query(
        tables.invoices.select(),
      ) as ReadonlyArray<unknown>;
      const filtersOnHuman = humanClient.store.query(
        tables.filters.select(),
      ) as ReadonlyArray<unknown>;

      expect(invoicesOnAgent).toHaveLength(1);
      expect(filtersOnHuman).toHaveLength(1);
    } finally {
      await humanClient.shutdown();
      await agentClient.shutdown();
    }
  }, 30_000);
});
