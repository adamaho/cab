import { Schema } from "@livestore/livestore";
import { JSONSchema } from "effect";

import type { Actor } from "./actor.ts";

// -- Types

/**
 * Read surface available to `decide` while validating a command.
 *
 * @category models
 * @since 0.0.0
 */
export interface CommandContext {
  /** Queries current materialized state with a LiveStore query builder. */
  query(query: object): unknown;
}

/**
 * Minimal structural store surface the dispatcher needs.
 *
 * **Details**
 *
 * LiveStore's `Store<TSchema>` generics are invariant, so concrete stores do
 * not flow into `Store<LiveStoreSchema.Any>` parameters. Accepting the narrow
 * structural surface keeps the dispatcher schema-agnostic.
 *
 * @category models
 * @since 0.0.0
 */
export interface DispatchTarget {
  query(query: object): unknown;
  // oxlint-disable-next-line no-explicit-any
  readonly commit: (...events: ReadonlyArray<any>) => void;
}

/**
 * Domain command definition: named, described, schema-validated intent.
 *
 * **Details**
 *
 * Commands are the only write path. `decide` validates intent against current
 * state and returns zero or more events to commit. It may throw
 * {@link CommandRejected} to refuse loudly with an agent-readable reason.
 * `describe`-ability is the point: every command carries a name, a plain
 * description, and an args schema so an agent can discover the write surface
 * without reading source code.
 *
 * @category models
 * @since 0.0.0
 */
export interface CommandDefinition<TArgs, TArgsEncoded> {
  readonly name: string;
  /** Plain-language behavior summary, written for agent discovery. */
  readonly description: string;
  /** Schema for command arguments. Unknown input is decoded before decide. */
  readonly args: Schema.Schema<TArgs, TArgsEncoded>;
  /** Turns validated intent into events, or throws {@link CommandRejected}. */
  readonly decide: (
    context: CommandContext,
    args: TArgs,
    actor: Actor,
  ) => ReadonlyArray<CommittableEvent>;
}

/**
 * Event input produced by a `decide` and accepted by `store.commit`.
 *
 * @category models
 * @since 0.0.0
 */
export interface CommittableEvent {
  readonly name: string;
  readonly args: unknown;
}

/**
 * Outcome of one dispatch: the committed event inputs, or a rejection reason.
 *
 * @category models
 * @since 0.0.0
 */
export interface DispatchResult {
  readonly events: ReadonlyArray<CommittableEvent>;
  readonly rejected?: string;
}

/**
 * Introspectable description of one command for agent discovery.
 *
 * @category models
 * @since 0.0.0
 */
export interface CommandDescription {
  readonly name: string;
  readonly description: string;
  readonly argsSchema: object;
}

// -- Errors

/**
 * Loud, reasoned refusal of a command by `decide`.
 *
 * **Details**
 *
 * Rejections are not defects: they are the domain saying no with a reason the
 * caller — human or agent — can act on. The dispatcher converts them into
 * `DispatchResult.rejected` instead of throwing across the boundary.
 *
 * @category errors
 * @since 0.0.0
 */
export class CommandRejected extends Error {
  override readonly name = "CommandRejected";

  constructor(readonly reason: string) {
    super(reason);
  }
}

// -- Constructors

/**
 * Defines a command while pinning args type inference.
 *
 * @category constructors
 * @since 0.0.0
 */
export function defineCommand<TArgs, TArgsEncoded>(
  definition: CommandDefinition<TArgs, TArgsEncoded>,
): CommandDefinition<TArgs, TArgsEncoded> {
  return definition;
}

/**
 * Dispatch and introspection surface over a command record.
 *
 * @category models
 * @since 0.0.0
 */
export interface Dispatcher<TCommands> {
  /**
   * Validates args against the command schema, runs decide against current
   * state, and commits the resulting events with the given actor identity.
   */
  readonly dispatch: (
    name: keyof TCommands & string,
    args: unknown,
    actor: Actor,
  ) => DispatchResult;

  /** Enumerates every command with its description and JSON Schema args. */
  readonly describe: () => ReadonlyArray<CommandDescription>;
}

/**
 * Builds the cab dispatch layer over a LiveStore store.
 *
 * **Details**
 *
 * This is the seam cab adds on top of LiveStore: LiveStore commits events
 * directly, cab routes all writes through named, schema-validated, actor-
 * attributed commands whose `decide` can consult current state and refuse.
 *
 * @category constructors
 * @since 0.0.0
 */
export function createDispatcher<
  // oxlint-disable-next-line no-explicit-any
  TCommands extends Record<string, CommandDefinition<any, any>>,
>(store: DispatchTarget, commands: TCommands): Dispatcher<TCommands> {
  const context: CommandContext = {
    query: (query) => store.query(query),
  };

  function dispatch(name: keyof TCommands & string, args: unknown, actor: Actor): DispatchResult {
    const command = commands[name];

    if (command === undefined) {
      throw new Error(
        `Unknown command "${name}". Known commands: ${Object.keys(commands).join(", ")}`,
      );
    }

    let events: ReadonlyArray<CommittableEvent>;

    try {
      const decoded = Schema.decodeUnknownSync(command.args)(args);
      events = command.decide(context, decoded, actor);
    } catch (error) {
      if (error instanceof CommandRejected) {
        return { events: [], rejected: error.reason };
      }

      throw error;
    }

    if (events.length > 0) {
      // oxlint-disable-next-line no-explicit-any
      store.commit(...(events as Array<any>));
    }

    return { events };
  }

  function describe(): ReadonlyArray<CommandDescription> {
    return Object.values(commands).map((command) => ({
      name: command.name,
      description: command.description,
      argsSchema: JSONSchema.make(command.args),
    }));
  }

  return { dispatch, describe };
}
