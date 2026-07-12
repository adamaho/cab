import { Schema } from "@livestore/livestore";

/**
 * Kind of participant acting on a store: a person or an autonomous agent.
 *
 * @category models
 * @since 0.0.0
 */
export const ActorKind = Schema.Literal("human", "agent");

/**
 * Kind of participant acting on a store.
 *
 * @category models
 * @since 0.0.0
 */
export type ActorKind = typeof ActorKind.Type;

/**
 * Identity of the participant that produced a command or event.
 *
 * **Details**
 *
 * LiveStore stamps facts with `clientId`/`sessionId` (device identity). Cab
 * additionally requires domain identity — who acted, human or agent — on every
 * event so history is attributable, auditable, and selectively rewindable.
 *
 * @category models
 * @since 0.0.0
 */
export const Actor = Schema.Struct({
  kind: ActorKind,
  id: Schema.String,
});

/**
 * Identity of the participant that produced a command or event.
 *
 * @category models
 * @since 0.0.0
 */
export type Actor = typeof Actor.Type;
