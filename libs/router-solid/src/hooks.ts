import type { RouterCommand, RouterState } from "@cab/router";
import type { Accessor } from "solid-js";

import { useRouter } from "./provider";
import { makeRouterDispatch, makeRouterNavigate, selectRouterState } from "./router";

/**
 * Configures selection from router state.
 *
 * @category models
 * @since 0.0.0
 */
export interface UseRouterStateOptions<TSelected> {
  readonly select: (state: RouterState) => TSelected;
  readonly equals?: (prev: TSelected, next: TSelected) => boolean;
}

/**
 * Reads the current router state as a total accessor.
 *
 * **Details**
 *
 * The accessor always returns the real folded model snapshot. Pass `select` to
 * derive the specific state slice a component renders.
 *
 * @category hooks
 * @since 0.0.0
 */
export function useRouterState(): Accessor<RouterState>;
export function useRouterState<TSelected>(
  options: UseRouterStateOptions<TSelected>,
): Accessor<TSelected>;
export function useRouterState<TSelected>(
  options?: UseRouterStateOptions<TSelected>,
): Accessor<RouterState | TSelected> {
  const router = useRouter();
  return options === undefined ? selectRouterState(router) : selectRouterState(router, options);
}

/**
 * Returns a function that navigates to an href.
 *
 * **Details**
 *
 * Returns `void` by design: navigation failures are recorded as
 * `NavigationFailed` journal facts, not thrown, so there is nothing for the
 * caller to await or catch.
 *
 * @see {@link useRouterDispatch} for dispatching typed commands
 * @category hooks
 * @since 0.0.0
 */
export function useRouterNavigate(): (href: string) => void {
  return makeRouterNavigate(useRouter());
}

/**
 * Returns a function that dispatches a typed router command.
 *
 * @see {@link useRouterNavigate} for the common navigation case
 * @category hooks
 * @since 0.0.0
 */
export function useRouterDispatch(): (command: RouterCommand) => void {
  return makeRouterDispatch(useRouter());
}
