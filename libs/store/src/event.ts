/**
 * Journal fact paired with the gapless sequence assigned by the store.
 *
 * **Details**
 *
 * Domain events stay free of store machinery. `Sequenced` is the retained
 * journal shape used for ordering, replay, and live journal streams.
 *
 * @category models
 * @since 0.0.0
 */
export interface Sequenced<TEvent> {
  readonly sequence: number;
  readonly event: TEvent;
}
