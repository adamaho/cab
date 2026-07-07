import type { RouterEvent } from "./event";

/**
 * Current router projection derived from the event journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface RouterState {
  readonly href: string;
}

/**
 * Creates the initial router projection from the current href.
 *
 * @category constructors
 * @since 0.0.0
 */
export function initial(href: string): RouterState {
  return { href };
}

/**
 * Applies one journal event to a router state projection.
 *
 * **Details**
 *
 * `NavigationCommitted` and `NavigationObserved` change the current href.
 * Requested and failed events are retained in the journal for observability but
 * leave projected state unchanged.
 *
 * @category reducers
 * @since 0.0.0
 */
export function reduce(state: RouterState, event: RouterEvent): RouterState {
  switch (event._tag) {
    case "NavigationRequested":
    case "NavigationFailed":
      return state;
    case "NavigationCommitted":
    case "NavigationObserved":
      return { href: event.href };
  }
}
