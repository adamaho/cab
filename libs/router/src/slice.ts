import { defineSlice, type SliceDefinition } from "@cab/store";
import { Data } from "effect";

import type { HistoryErrorReason } from "./history";

/**
 * Current router projection derived from the event journal.
 *
 * @category models
 * @since 0.0.0
 */
export type RouterState = {
  readonly href: string;
};

/**
 * User-originated router commands accepted by the router service.
 *
 * **Details**
 *
 * Commands express caller intent. Outcome commands are saga-internal and are
 * only constructed after a real history outcome.
 *
 * @see {@link RouterEvent} for journal facts emitted by accepted commands
 * @category models
 * @since 0.0.0
 */
export type RouterCommand = Data.TaggedEnum<{
  NavigationRequested: {
    readonly href: string;
  };
}>;

/**
 * Constructors and matchers for user-originated router commands.
 *
 * @category constructors
 * @since 0.0.0
 */
export const RouterCommand = Data.taggedEnum<RouterCommand>();

/**
 * Full router slice command vocabulary consumed by the pure slice.
 *
 * **Details**
 *
 * This type is intentionally not re-exported from the package entrypoint.
 * Consumers can dispatch only `RouterCommand`; the router saga privately widens
 * to this union when recording history outcomes.
 *
 * @category models
 * @since 0.0.0
 */
export type RouterSliceCommand = Data.TaggedEnum<{
  NavigationRequested: {
    readonly href: string;
  };
  NavigationCommitted: {
    readonly href: string;
  };
  NavigationObserved: {
    readonly href: string;
  };
  NavigationFailed: {
    readonly href: string;
    readonly reason: HistoryErrorReason;
    readonly cause?: unknown;
  };
}>;

/**
 * Package-internal constructors for the full router slice command vocabulary.
 *
 * **Details**
 *
 * This export exists for sibling router modules only and is deliberately absent
 * from the package entrypoint.
 */
export const RouterSliceCommand = Data.taggedEnum<RouterSliceCommand>();

/**
 * Router facts appended to the store-owned journal.
 *
 * **Details**
 *
 * `NavigationRequested` records accepted caller intent, `NavigationCommitted`
 * records a successful history mutation, `NavigationObserved` records an
 * external committed navigation, and `NavigationFailed` records a failed
 * history mutation. Sequence numbers live on the store's `Sequenced` wrapper.
 *
 * @see {@link RouterCommand} for user-originated navigation inputs
 * @category models
 * @since 0.0.0
 */
export type RouterEvent = Data.TaggedEnum<{
  NavigationRequested: {
    readonly href: string;
  };
  NavigationCommitted: {
    readonly href: string;
  };
  NavigationObserved: {
    readonly href: string;
  };
  NavigationFailed: {
    readonly href: string;
    readonly reason: HistoryErrorReason;
    readonly cause?: unknown;
  };
}>;

/**
 * Constructors and matchers for router journal events.
 *
 * @category constructors
 * @since 0.0.0
 */
export const RouterEvent = Data.taggedEnum<RouterEvent>();

/**
 * Creates the initial router projection from the current href.
 *
 * @category constructors
 * @since 0.0.0
 */
export function initial(href: string): RouterState {
  return { href };
}

function decide(state: RouterState, command: RouterSliceCommand): ReadonlyArray<RouterEvent> {
  return RouterSliceCommand.$match(command, {
    NavigationRequested: ({ href }) =>
      state.href === href ? [] : [RouterEvent.NavigationRequested({ href })],
    NavigationObserved: ({ href }) =>
      state.href === href ? [] : [RouterEvent.NavigationObserved({ href })],
    NavigationCommitted: ({ href }) => [RouterEvent.NavigationCommitted({ href })],
    NavigationFailed: ({ href, reason, cause }) => [
      RouterEvent.NavigationFailed({ href, reason, ...(cause === undefined ? {} : { cause }) }),
    ],
  });
}

function reduce(state: RouterState, event: RouterEvent): RouterState {
  return RouterEvent.$match(event, {
    NavigationRequested: () => state,
    NavigationFailed: () => state,
    NavigationCommitted: ({ href }) => ({ href }),
    NavigationObserved: ({ href }) => ({ href }),
  });
}

function make(href: string): SliceDefinition<RouterState, RouterSliceCommand, RouterEvent> {
  return defineSlice({
    name: "router",
    initial: initial(href),
    decide,
    reduce,
  });
}

/**
 * Constructors for the router store slice.
 *
 * **Details**
 *
 * `make(href)` builds the slice definition seeded from the history service's
 * current href. The definition is a factory rather than a constant because the
 * store seeds state from `definition.initial` at construction time.
 *
 * @category constructors
 * @since 0.0.0
 */
export const RouterSlice = {
  make,
} as const;
