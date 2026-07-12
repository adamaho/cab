import { Effect, Schema } from "effect";
import type {
  Actor,
  CommandEnvelope,
  EffectAuthority,
  EffectPhase,
  EffectReplayPolicy,
  FactEnvelope,
} from "./model.ts";
import type { Query } from "./query.ts";
import type { Decision } from "./decision.ts";

/** Controls how concurrent invocations of one effect are owned. @category effects @since 0.0.0 */
export type EffectConcurrency<Args> =
  | { readonly _tag: "Every"; readonly limit?: number }
  | { readonly _tag: "Latest"; readonly key: (args: Args) => string }
  | { readonly _tag: "Queue"; readonly key: (args: Args) => string; readonly limit?: number };

/** Is pure serializable data proposing one event. @category definitions @since 0.0.0 */
export interface EventInvocation<Name extends string, Args> {
  readonly _tag: "EventInvocation";
  readonly event: Name;
  readonly version: number;
  readonly args: Args;
}

/** Defines one stable semantic journal fact. @category definitions @since 0.0.0 */
export interface EventDefinition<Name extends string, Args> {
  readonly _tag: "EventDefinition";
  readonly name: Name;
  readonly version: number;
  readonly schema: Schema.Schema<Args>;
  readonly scope: "global" | "session" | "client";
  readonly retention: "permanent" | "compactable" | "ephemeral";
  readonly render: (args: Args, envelope: FactEnvelope) => string;
  readonly redact?: (args: Args) => Args;
  readonly make: (args: Args) => EventInvocation<Name, Args>;
}

/** Creates a typed, pure event definition and constructor. @category definitions @since 0.0.0 */
export function defineEvent<const Name extends string, Args>(
  definition: Omit<EventDefinition<Name, Args>, "_tag" | "make">,
): EventDefinition<Name, Args> {
  return {
    ...definition,
    _tag: "EventDefinition",
    make: (args) => ({
      _tag: "EventInvocation",
      event: definition.name,
      version: definition.version,
      args,
    }),
  };
}

/** Is pure serializable data proposing one command. @category definitions @since 0.0.0 */
export interface CommandInvocation<Name extends string, Args> {
  readonly _tag: "CommandInvocation";
  readonly command: Name;
  readonly args: Args;
}

/** Controls who may dispatch a command definition. @category definitions @since 0.0.0 */
export type CommandExposure = "public" | "outcome";

/** Provides immutable state and pure query access to a decision. @category definitions @since 0.0.0 */
export interface DecideContext<State> {
  readonly state: Readonly<State>;
  readonly command: CommandEnvelope;
  readonly query: <A>(query: Query<A>) => A;
}

/** Defines a typed command and its synchronous pure decision. @category definitions @since 0.0.0 */
export interface CommandDefinition<Name extends string, Args, State> {
  readonly _tag: "CommandDefinition";
  readonly name: Name;
  readonly description: string;
  readonly args: Schema.Schema<Args>;
  readonly exposure: CommandExposure;
  readonly possibleEffects?: readonly string[];
  readonly decide: (context: DecideContext<State>, args: Args) => Decision;
  readonly make: (args: Args) => CommandInvocation<Name, Args>;
}

/** Creates a typed, pure command definition and constructor. @category definitions @since 0.0.0 */
export function defineCommand<const Name extends string, Args, State>(
  definition: Omit<CommandDefinition<Name, Args, State>, "_tag" | "make">,
): CommandDefinition<Name, Args, State> {
  return {
    ...definition,
    _tag: "CommandDefinition",
    make: (args) => ({ _tag: "CommandInvocation", command: definition.name, args }),
  };
}

/** Builds an injective persisted key for Latest effect concurrency. @category effects @since 0.0.0 */
export function effectConcurrencyKey(effect: string, key: string): string {
  return JSON.stringify([effect, key]);
}

/** Is pure serializable data selecting registered external work. @category effects @since 0.0.0 */
export interface EffectInvocation<Name extends string, Args> {
  readonly _tag: "EffectInvocation";
  readonly effect: Name;
  readonly version: number;
  readonly args: Args;
}

/** Signals that an execution lost its branch or concurrency lease. @category errors @since 0.0.0 */
export class StaleExecution {
  readonly _tag = "StaleExecution";
  constructor(readonly message: string) {}
}

/** Carries stable causation and lease checks into an effect program. @category effects @since 0.0.0 */
export interface EffectRunContext {
  readonly executionId: string;
  readonly invocationId: string;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly actor: Actor;
  readonly mode: "live" | "manual-replay";
  readonly attempt: number;
  readonly ensureCurrent: Effect.Effect<void, StaleExecution>;
}

/** Defines named Effect-native external work and optional typed outcome mappings. @category effects @since 0.0.0 */
export interface EffectDefinition<Name extends string, Args, Success, Failure, Requirements> {
  readonly _tag: "EffectDefinition";
  readonly name: Name;
  readonly version: number;
  readonly description: string;
  readonly args: Schema.Schema<Args>;
  readonly phase: EffectPhase;
  readonly replay: EffectReplayPolicy;
  readonly authority: EffectAuthority;
  readonly concurrency: EffectConcurrency<Args>;
  readonly run: (
    args: Args,
    context: EffectRunContext,
  ) => Effect.Effect<Success, Failure, Requirements>;
  readonly onSuccess?: (
    value: Success,
    args: Args,
    context: EffectRunContext,
  ) => CommandInvocation<string, unknown> | void;
  readonly onFailure?: (
    error: Failure,
    args: Args,
    context: EffectRunContext,
  ) => CommandInvocation<string, unknown> | void;
  readonly make: (args: Args) => EffectInvocation<Name, Args>;
}

/** Creates a named effect definition without constructing or executing its program. @category effects @since 0.0.0 */
export function defineEffect<const Name extends string, Args, Success, Failure, Requirements>(
  definition: Omit<EffectDefinition<Name, Args, Success, Failure, Requirements>, "_tag" | "make">,
): EffectDefinition<Name, Args, Success, Failure, Requirements> {
  return {
    ...definition,
    _tag: "EffectDefinition",
    make: (args) => ({
      _tag: "EffectInvocation",
      effect: definition.name,
      version: definition.version,
      args,
    }),
  };
}
