import { Data, Effect } from "effect";
import type { CommandDefinition, EffectDefinition, EventDefinition } from "./definition.ts";
import type { Fact } from "./model.ts";

/** Is the common covariant identity retained in heterogeneous definition arrays. @category definitions @since 0.0.0 */
export interface DefinitionMarker {
  readonly _tag: "EventDefinition" | "CommandDefinition" | "EffectDefinition";
  readonly name: string;
}

/** Groups one capability's state, facts, commands, effects, and fold. @category features @since 0.0.0 */
export interface Feature<Name extends string, State, Requirements = never> {
  readonly _tag: "Feature";
  readonly name: Name;
  readonly initialState: State;
  readonly events: readonly DefinitionMarker[];
  readonly commands: readonly DefinitionMarker[];
  readonly effects: readonly DefinitionMarker[];
  readonly reduce: (state: State, fact: Fact) => State;
  readonly _Requirements?: (_: Requirements) => Requirements;
}

/** Creates a vertical feature bundle. @category features @since 0.0.0 */
export function defineFeature<const Name extends string, State, Requirements = never>(
  definition: Omit<Feature<Name, State, Requirements>, "_tag" | "_Requirements">,
): Feature<Name, State, Requirements> {
  return { ...definition, _tag: "Feature" };
}

/** Is the structural feature constraint used by heterogeneous feature tuples. @category features @since 0.0.0 */
export interface FeatureLike {
  readonly _tag: "Feature";
  readonly name: string;
  readonly initialState: unknown;
  readonly events: readonly DefinitionMarker[];
  readonly commands: readonly DefinitionMarker[];
  readonly effects: readonly DefinitionMarker[];
  readonly reduce: (state: never, fact: Fact) => unknown;
}

/** Extracts the composed object state from a feature tuple. @category types @since 0.0.0 */
export type StateOf<Features extends readonly FeatureLike[]> = {
  readonly [FeatureValue in Features[number] as FeatureValue["name"]]: FeatureValue extends Feature<
    string,
    infer State,
    infer _Requirements
  >
    ? State
    : never;
};

/** Extracts all service requirements from a feature tuple. @category types @since 0.0.0 */
export type RequirementsOf<Features extends readonly FeatureLike[]> =
  Features[number] extends Feature<string, infer _State, infer Requirements> ? Requirements : never;

/** Reports invalid or duplicate feature registry definitions. @category errors @since 0.0.0 */
export class DefinitionRegistryError extends Data.TaggedError("DefinitionRegistryError")<{
  readonly code:
    | "duplicate-feature"
    | "duplicate-event"
    | "duplicate-command"
    | "duplicate-effect"
    | "invalid-name"
    | "invalid-version"
    | "unserializable-initial-state"
    | "invalid-concurrency"
    | "queue-unsupported";
  readonly name: string;
  readonly message: string;
}> {}

type AnyEvent = EventDefinition<string, unknown>;
type AnyCommand = CommandDefinition<string, unknown, unknown>;
type AnyEffect = EffectDefinition<string, unknown, unknown, unknown, unknown>;

/** Is one operationally erased feature in the validated registry. @category features @since 0.0.0 */
export interface RegisteredFeature {
  readonly name: string;
  readonly initialState: unknown;
  readonly events: readonly AnyEvent[];
  readonly commands: readonly AnyCommand[];
  readonly effects: readonly AnyEffect[];
  readonly reduce: (state: unknown, fact: Fact) => unknown;
}

/** Is the validated lookup surface used by folding and dispatch. @category features @since 0.0.0 */
export interface FeatureRegistry {
  readonly features: readonly RegisteredFeature[];
  readonly featureByName: ReadonlyMap<string, RegisteredFeature>;
  readonly eventByName: ReadonlyMap<string, AnyEvent>;
  readonly commandByName: ReadonlyMap<string, AnyCommand>;
  readonly commandFeature: ReadonlyMap<string, string>;
  readonly effectByName: ReadonlyMap<string, AnyEffect>;
}

/** Returns whether a value is safe to persist in the POC journal. @category serialization @since 0.0.0 */
export function isSerializable(value: unknown): boolean {
  const visiting = new Set<object>();
  function visit(current: unknown): boolean {
    if (current === null) return true;
    switch (typeof current) {
      case "string":
      case "boolean":
        return true;
      case "number":
        return Number.isFinite(current);
      case "undefined":
      case "bigint":
      case "function":
      case "symbol":
        return false;
      case "object": {
        if (visiting.has(current)) return false;
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
        visiting.add(current);
        const valid = Array.isArray(current)
          ? current.every(visit)
          : Object.entries(current).every(([, item]) => visit(item));
        visiting.delete(current);
        return valid;
      }
      default:
        return false;
    }
  }
  return visit(value);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Copies and deeply freezes plain serializable runtime data. @category serialization @since 0.0.0 */
export function cloneSerializable<T>(value: T): T {
  if (!isSerializable(value)) throw new TypeError("Value is not plain serializable data");
  return freezeDeep(structuredClone(value));
}

function duplicate<T>(
  target: Map<string, T>,
  name: string,
  value: T,
  code: DefinitionRegistryError["code"],
): DefinitionRegistryError | undefined {
  if (target.has(name)) {
    return new DefinitionRegistryError({ code, name, message: `Duplicate definition "${name}"` });
  }
  target.set(name, value);
  return undefined;
}

function registerFeature(feature: FeatureLike): RegisteredFeature {
  return {
    name: feature.name,
    initialState: feature.initialState,
    events: feature.events as unknown as readonly AnyEvent[],
    commands: feature.commands as unknown as readonly AnyCommand[],
    effects: feature.effects as unknown as readonly AnyEffect[],
    reduce: (state, fact) => feature.reduce(state as never, fact),
  };
}

/** Validates and indexes a tuple of vertical features. @category features @since 0.0.0 */
export function makeFeatureRegistry(
  input: readonly FeatureLike[],
): Effect.Effect<FeatureRegistry, DefinitionRegistryError> {
  return Effect.gen(function* () {
    const features = input.map(registerFeature);
    const featureByName = new Map<string, RegisteredFeature>();
    const eventByName = new Map<string, AnyEvent>();
    const commandByName = new Map<string, AnyCommand>();
    const commandFeature = new Map<string, string>();
    const effectByName = new Map<string, AnyEffect>();

    for (const registered of features) {
      if (registered.name.length === 0) {
        return yield* Effect.fail(
          new DefinitionRegistryError({
            code: "invalid-name",
            name: registered.name,
            message: "Feature names must not be empty",
          }),
        );
      }
      if (!isSerializable(registered.initialState)) {
        return yield* Effect.fail(
          new DefinitionRegistryError({
            code: "unserializable-initial-state",
            name: registered.name,
            message: `Initial state for "${registered.name}" is not serializable`,
          }),
        );
      }
      const feature: RegisteredFeature = {
        ...registered,
        initialState: cloneSerializable(registered.initialState),
      };
      const featureError = duplicate(featureByName, feature.name, feature, "duplicate-feature");
      if (featureError) return yield* Effect.fail(featureError);

      for (const event of feature.events) {
        if (event.version < 1 || !Number.isInteger(event.version)) {
          return yield* Effect.fail(
            new DefinitionRegistryError({
              code: "invalid-version",
              name: event.name,
              message: `Event "${event.name}" must have a positive integer version`,
            }),
          );
        }
        const error = duplicate(eventByName, event.name, event, "duplicate-event");
        if (error) return yield* Effect.fail(error);
      }
      for (const command of feature.commands) {
        if (!command.name.includes(".")) {
          return yield* Effect.fail(
            new DefinitionRegistryError({
              code: "invalid-name",
              name: command.name,
              message: `Command "${command.name}" must be namespaced`,
            }),
          );
        }
        const error = duplicate(commandByName, command.name, command, "duplicate-command");
        if (error) return yield* Effect.fail(error);
        commandFeature.set(command.name, feature.name);
      }
      for (const effect of feature.effects) {
        if (effect.version < 1 || !Number.isInteger(effect.version)) {
          return yield* Effect.fail(
            new DefinitionRegistryError({
              code: "invalid-version",
              name: effect.name,
              message: `Effect "${effect.name}" must have a positive integer version`,
            }),
          );
        }
        if (
          effect.concurrency._tag === "Every" &&
          effect.concurrency.limit !== undefined &&
          (!Number.isInteger(effect.concurrency.limit) || effect.concurrency.limit < 1)
        ) {
          return yield* Effect.fail(
            new DefinitionRegistryError({
              code: "invalid-concurrency",
              name: effect.name,
              message: `Effect "${effect.name}" Every limit must be a positive integer`,
            }),
          );
        }
        if (effect.concurrency._tag === "Queue") {
          return yield* Effect.fail(
            new DefinitionRegistryError({
              code: "queue-unsupported",
              name: effect.name,
              message: `Effect "${effect.name}" uses Queue, which the POC does not implement`,
            }),
          );
        }
        const error = duplicate(effectByName, effect.name, effect, "duplicate-effect");
        if (error) return yield* Effect.fail(error);
      }
    }

    return {
      features: [...featureByName.values()],
      featureByName,
      eventByName,
      commandByName,
      commandFeature,
      effectByName,
    };
  });
}
