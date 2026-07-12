import type { Stream } from "effect";

/** Identifies the principal responsible for an intent. @category model @since 0.0.0 */
export interface Actor {
  readonly kind: "human" | "agent" | "system" | "external";
  readonly id: string;
}

/** Identifies how a command entered the runtime. @category model @since 0.0.0 */
export type CommandOrigin =
  | { readonly _tag: "Actor" }
  | { readonly _tag: "Effect"; readonly executionId: string }
  | { readonly _tag: "Subscription"; readonly subscriptionId: string }
  | { readonly _tag: "External"; readonly adapterId: string };

/** Carries attribution and causation for one command attempt. @category model @since 0.0.0 */
export interface CommandEnvelope {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly actor: Actor;
  readonly issuedAt: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly origin: CommandOrigin;
}

/** Identifies one atomic accepted command transaction. @category model @since 0.0.0 */
export interface CommitEnvelope {
  readonly id: string;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly commandId: string;
  readonly correlationId: string;
  readonly committedAt: number;
}

/** Is the immutable attributed journal representation of one semantic event. @category model @since 0.0.0 */
export interface Fact {
  readonly id: string;
  readonly sequence: number;
  readonly name: string;
  readonly version: number;
  readonly args: unknown;
  readonly actor: Actor;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly at: number;
}

/** Is the envelope available to event narration and redaction code. @category model @since 0.0.0 */
export type FactEnvelope = Omit<Fact, "name" | "version" | "args">;

/** Selects when committed external work becomes eligible. @category effects @since 0.0.0 */
export type EffectPhase = "after-commit" | "after-render";

/** Selects whether explicit historical presentation replay is permitted. @category effects @since 0.0.0 */
export type EffectReplayPolicy = "never" | "manual";

/** Declares the future placement authority for an effect. @category effects @since 0.0.0 */
export type EffectAuthority = "client" | "session" | "server";

/** Coordinates a renderer with one published runtime revision. @category rendering @since 0.0.0 */
export interface RenderToken {
  readonly rendererId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly mode: "live" | "historical";
}

/** Is a serializable committed effect outbox record. @category journal @since 0.0.0 */
export interface CommittedEffectInvocation {
  readonly id: string;
  readonly definition: string;
  readonly version: number;
  readonly args: unknown;
  readonly ordinal: number;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly actor: Actor;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly triggerSequence: number;
  readonly phase: EffectPhase;
  readonly replay: EffectReplayPolicy;
  readonly authority: EffectAuthority;
  readonly concurrencyKey?: string;
  readonly renderToken?: RenderToken;
  readonly status: "pending" | "claimed" | "terminal" | "cancelled";
}

/** Records operational effect lifecycle separately from semantic history. @category telemetry @since 0.0.0 */
export interface EffectExecution {
  readonly id: string;
  readonly invocationId: string;
  readonly effect: string;
  readonly version: number;
  readonly args: unknown;
  readonly commandId: string;
  readonly commitId: string;
  readonly correlationId: string;
  readonly actor: Actor;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly phase: EffectPhase;
  readonly mode: "live" | "manual-replay";
  readonly concurrencyKey?: string;
  readonly attempt: number;
  readonly status:
    | "pending"
    | "awaiting-render"
    | "running"
    | "outcome-dispatched"
    | "succeeded"
    | "failed"
    | "interrupted"
    | "stale"
    | "defect";
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly detail?: string;
}

/** Is one atomically published folded revision. @category runtime @since 0.0.0 */
export interface RuntimeRevision<State> {
  readonly revision: number;
  readonly sequence: number;
  readonly headSequence: number;
  readonly mode: "live" | "historical";
  readonly state: Readonly<State>;
  readonly facts: readonly Fact[];
  readonly renderToken: RenderToken;
}

/** Is the current runtime and journal view. @category runtime @since 0.0.0 */
export interface RuntimeSnapshot<State> {
  readonly state: Readonly<State>;
  readonly liveState: Readonly<State>;
  readonly journal: readonly Fact[];
  readonly invocations: readonly CommittedEffectInvocation[];
  readonly sequence: number;
  readonly headSequence: number;
  readonly revision: number;
  readonly mode: "live" | "historical";
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly renderToken: RenderToken;
}

/** Is a fold-only historical result. @category history @since 0.0.0 */
export interface HistoricalSnapshot<State> {
  readonly state: Readonly<State>;
  readonly sequence: number;
  readonly facts: readonly Fact[];
  readonly branchId: string;
}

/** Describes a public command for UI and agent tooling. @category introspection @since 0.0.0 */
export interface CommandDescription {
  readonly name: string;
  readonly description: string;
  readonly argsSchema: object;
  readonly possibleEffects: readonly {
    readonly name: string;
    readonly phase: EffectPhase;
    readonly replay: EffectReplayPolicy;
  }[];
}

/** Describes the composed runtime registry. @category introspection @since 0.0.0 */
export interface RuntimeDescription {
  readonly features: readonly string[];
  readonly commands: readonly CommandDescription[];
  readonly events: readonly string[];
  readonly effects: readonly {
    readonly name: string;
    readonly version: number;
    readonly description: string;
    readonly phase: EffectPhase;
    readonly replay: EffectReplayPolicy;
    readonly authority: EffectAuthority;
    readonly concurrency: "Every" | "Latest" | "Queue";
  }[];
}

/** Gives consumers read-only execution telemetry. @category telemetry @since 0.0.0 */
export interface EffectTelemetry {
  readonly executions: import("effect").Effect.Effect<readonly EffectExecution[]>;
  readonly changes: Stream.Stream<EffectExecution>;
}
