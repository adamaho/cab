import { Data } from "effect";

import type { HistoryErrorReason } from "./history";

/**
 * User-originated router commands accepted by the router service.
 *
 * **Details**
 *
 * Commands express caller intent. They are not journal facts until the router
 * assigns sequence numbers and appends corresponding `RouterEvent` values.
 *
 * @see {@link RouterEvent} for sequenced journal facts
 * @category models
 * @since 0.0.0
 */
export type RouterCommand = Data.TaggedEnum<{
  NavigationRequested: {
    readonly href: string;
  };
}>;

/**
 * Constructors and matchers for router commands.
 *
 * @category constructors
 * @since 0.0.0
 */
export const RouterCommand = Data.taggedEnum<RouterCommand>();

/**
 * Sequenced facts appended to the in-memory router journal.
 *
 * **Details**
 *
 * `NavigationRequested` records caller intent, `NavigationCommitted` records a
 * successful history mutation, `NavigationObserved` records an external
 * committed navigation, and `NavigationFailed` records a failed history
 * mutation. Router state is derived only by folding committed and observed
 * events.
 *
 * @see {@link RouterCommand} for user-originated navigation inputs
 * @category models
 * @since 0.0.0
 */
export type RouterEvent = Data.TaggedEnum<{
  NavigationRequested: {
    readonly sequence: number;
    readonly href: string;
  };
  NavigationCommitted: {
    readonly sequence: number;
    readonly href: string;
  };
  NavigationObserved: {
    readonly sequence: number;
    readonly href: string;
  };
  NavigationFailed: {
    readonly sequence: number;
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
