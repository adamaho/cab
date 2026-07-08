/**
 * Domain-owned definition for one event-sourced store slice.
 *
 * **Details**
 *
 * `decide` turns caller intent into zero or more domain events using the
 * current folded state. `reduce` is the pure total fold from state and event to
 * the next state. The store supplies sequencing, journaling, serialization, and
 * reactivity around this definition.
 *
 * @category models
 * @since 0.0.0
 */
export interface SliceDefinition<TState extends Record<string, unknown>, TCommand, TEvent> {
  readonly name: string;
  readonly initial: TState;
  readonly decide: (state: TState, command: TCommand) => ReadonlyArray<TEvent>;
  readonly reduce: (state: TState, event: TEvent) => TState;
}

/**
 * Defines a store slice while preserving command, event, and state inference.
 *
 * @category constructors
 * @since 0.0.0
 */
export function defineSlice<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): SliceDefinition<TState, TCommand, TEvent> {
  return definition;
}
