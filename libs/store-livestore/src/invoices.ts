import { Events, makeSchema, Schema, State } from "@livestore/livestore";

import { Actor } from "./actor.ts";
import { CommandRejected, defineCommand } from "./command.ts";

// -- Types

/**
 * Lifecycle status of an invoice.
 *
 * @category models
 * @since 0.0.0
 */
export const InvoiceStatus = Schema.Literal("draft", "sent", "paid", "overdue");

/**
 * Lifecycle status of an invoice.
 *
 * @category models
 * @since 0.0.0
 */
export type InvoiceStatus = typeof InvoiceStatus.Type;

/**
 * Filterable fields of the invoice board.
 *
 * @category models
 * @since 0.0.0
 */
export const FilterField = Schema.Literal("status", "vendor");

/**
 * Filterable fields of the invoice board.
 *
 * @category models
 * @since 0.0.0
 */
export type FilterField = typeof FilterField.Type;

const statusTransitions: Record<InvoiceStatus, ReadonlyArray<InvoiceStatus>> = {
  draft: ["sent"],
  sent: ["paid", "overdue"],
  overdue: ["paid"],
  paid: [],
};

// -- State

/**
 * Materialized SQLite tables for the invoice board.
 *
 * **Details**
 *
 * `filterHistory` is an append-only projection of every filter change with
 * full actor provenance and event sequence. It exists so history-aware
 * commands (undo, rewind) can be decided from state instead of re-reading the
 * eventlog.
 *
 * @category models
 * @since 0.0.0
 */
export const tables = {
  invoices: State.SQLite.table({
    name: "invoices",
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      vendor: State.SQLite.text({ nullable: false }),
      status: State.SQLite.text({ nullable: false }),
      amount: State.SQLite.real({ nullable: false }),
    },
  }),
  filters: State.SQLite.table({
    name: "filters",
    columns: {
      field: State.SQLite.text({ primaryKey: true }),
      value: State.SQLite.text({ nullable: true }),
      appliedByKind: State.SQLite.text({ nullable: false }),
      appliedById: State.SQLite.text({ nullable: false }),
    },
  }),
  filterHistory: State.SQLite.table({
    name: "filterHistory",
    columns: {
      eventId: State.SQLite.text({ primaryKey: true }),
      globalSeq: State.SQLite.integer({ nullable: false }),
      clientSeq: State.SQLite.integer({ nullable: false }),
      field: State.SQLite.text({ nullable: false }),
      value: State.SQLite.text({ nullable: true }),
      actorKind: State.SQLite.text({ nullable: false }),
      actorId: State.SQLite.text({ nullable: false }),
    },
  }),
};

// -- Events

/**
 * Synced domain events for the invoice board. Every event carries the acting
 * human or agent so the journal reads as attributable history.
 *
 * @category models
 * @since 0.0.0
 */
export const events = {
  invoiceAdded: Events.synced({
    name: "v1.InvoiceAdded",
    schema: Schema.Struct({
      id: Schema.String,
      vendor: Schema.String,
      status: InvoiceStatus,
      amount: Schema.Number,
      actor: Actor,
    }),
  }),
  invoiceStatusChanged: Events.synced({
    name: "v1.InvoiceStatusChanged",
    schema: Schema.Struct({
      id: Schema.String,
      status: InvoiceStatus,
      actor: Actor,
    }),
  }),
  filterApplied: Events.synced({
    name: "v1.FilterApplied",
    schema: Schema.Struct({
      field: FilterField,
      value: Schema.NullOr(Schema.String),
      actor: Actor,
    }),
  }),
};

const materializers = State.SQLite.materializers(events, {
  "v1.InvoiceAdded": ({ id, vendor, status, amount }) =>
    tables.invoices.insert({ id, vendor, status, amount }),
  "v1.InvoiceStatusChanged": ({ id, status }) => tables.invoices.update({ status }).where({ id }),
  "v1.FilterApplied": ({ field, value, actor }, ctx) => [
    tables.filters.delete().where({ field }),
    tables.filters.insert({
      field,
      value,
      appliedByKind: actor.kind,
      appliedById: actor.id,
    }),
    tables.filterHistory.insert({
      eventId: `${ctx.event.seqNum.global}.${ctx.event.seqNum.client}`,
      globalSeq: ctx.event.seqNum.global,
      clientSeq: ctx.event.seqNum.client,
      field,
      value,
      actorKind: actor.kind,
      actorId: actor.id,
    }),
  ],
});

const state = State.SQLite.makeState({ tables, materializers });

/**
 * Complete LiveStore schema for the invoice board slice.
 *
 * @category models
 * @since 0.0.0
 */
export const schema = makeSchema({ events, state });

// -- Commands

type FilterHistoryRow = {
  readonly eventId: string;
  readonly globalSeq: number;
  readonly clientSeq: number;
  readonly field: FilterField;
  readonly value: string | null;
  readonly actorKind: string;
  readonly actorId: string;
};

function historyNewestFirst(rows: ReadonlyArray<FilterHistoryRow>): Array<FilterHistoryRow> {
  return [...rows].sort((a, b) =>
    b.globalSeq === a.globalSeq ? b.clientSeq - a.clientSeq : b.globalSeq - a.globalSeq,
  );
}

/**
 * Command surface of the invoice board.
 *
 * **Details**
 *
 * Every write goes through these definitions: schema-validated args, current-
 * state-aware validation in `decide`, reasoned rejection, and actor
 * attribution. `undoLastFilterChangeBy` demonstrates history-aware compensation:
 * undoing one actor's last change restores the previous value as a new fact —
 * history is never deleted, and the undo itself is attributed to whoever asked
 * for it.
 *
 * @category models
 * @since 0.0.0
 */
export const commands = {
  addInvoice: defineCommand({
    name: "addInvoice",
    description:
      "Add a new draft invoice to the board. Rejects non-positive amounts; adding an id that already exists is a no-op.",
    args: Schema.Struct({
      id: Schema.String,
      vendor: Schema.String,
      amount: Schema.Number,
    }),
    decide: ({ query }, args, actor) => {
      if (args.amount <= 0) {
        throw new CommandRejected(`amount must be positive, got ${args.amount}`);
      }

      const existing = query(tables.invoices.where({ id: args.id })) as ReadonlyArray<unknown>;

      if (existing.length > 0) {
        return [];
      }

      return [
        events.invoiceAdded({
          id: args.id,
          vendor: args.vendor,
          status: "draft",
          amount: args.amount,
          actor,
        }),
      ];
    },
  }),

  changeInvoiceStatus: defineCommand({
    name: "changeInvoiceStatus",
    description:
      "Move an invoice through its lifecycle. Allowed transitions: draft→sent, sent→paid, sent→overdue, overdue→paid.",
    args: Schema.Struct({
      id: Schema.String,
      status: InvoiceStatus,
    }),
    decide: ({ query }, args, actor) => {
      const rows = query(tables.invoices.where({ id: args.id })) as ReadonlyArray<{
        status: InvoiceStatus;
      }>;
      const invoice = rows[0];

      if (invoice === undefined) {
        throw new CommandRejected(`invoice "${args.id}" does not exist`);
      }

      if (invoice.status === args.status) {
        return [];
      }

      if (!statusTransitions[invoice.status].includes(args.status)) {
        throw new CommandRejected(
          `cannot move invoice "${args.id}" from "${invoice.status}" to "${args.status}"; allowed: ${
            statusTransitions[invoice.status].join(", ") || "none"
          }`,
        );
      }

      return [events.invoiceStatusChanged({ id: args.id, status: args.status, actor })];
    },
  }),

  applyFilter: defineCommand({
    name: "applyFilter",
    description:
      "Apply or clear (value: null) a filter on the invoice board. Applying the current value is a no-op.",
    args: Schema.Struct({
      field: FilterField,
      value: Schema.NullOr(Schema.String),
    }),
    decide: ({ query }, args, actor) => {
      const rows = query(tables.filters.where({ field: args.field })) as ReadonlyArray<{
        value: string | null;
      }>;
      const current = rows[0]?.value ?? null;

      if (current === args.value) {
        return [];
      }

      return [events.filterApplied({ field: args.field, value: args.value, actor })];
    },
  }),

  undoLastFilterChangeBy: defineCommand({
    name: "undoLastFilterChangeBy",
    description:
      "Compensate the most recent filter change made by the given actor kind, restoring the value that field held before it. History is preserved: the undo is committed as a new attributed fact.",
    args: Schema.Struct({
      kind: Schema.Literal("human", "agent"),
    }),
    decide: ({ query }, args, actor) => {
      const history = historyNewestFirst(
        query(tables.filterHistory.select()) as ReadonlyArray<FilterHistoryRow>,
      );
      const target = history.find((row) => row.actorKind === args.kind);

      if (target === undefined) {
        throw new CommandRejected(`no filter changes by any ${args.kind} to undo`);
      }

      const previous = history.find(
        (row) =>
          row.field === target.field &&
          (row.globalSeq < target.globalSeq ||
            (row.globalSeq === target.globalSeq && row.clientSeq < target.clientSeq)),
      );
      const restoredValue = previous?.value ?? null;

      const currentRows = query(tables.filters.where({ field: target.field })) as ReadonlyArray<{
        value: string | null;
      }>;
      const current = currentRows[0]?.value ?? null;

      if (current === restoredValue) {
        return [];
      }

      return [events.filterApplied({ field: target.field, value: restoredValue, actor })];
    },
  }),
};
