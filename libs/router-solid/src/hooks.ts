import type { RouterCommand, RouterState } from "@cab/router";
import type { Accessor } from "solid-js";

import { useRouter } from "./provider";
import { SolidRouter } from "./router";

export interface UseRouterStateOptions<TSelected> {
  readonly select: (state: RouterState) => TSelected;
}

/**
 * Reads the current router state as a total accessor.
 *
 * **Details**
 *
 * The accessor always returns a `RouterState`: the synchronous construction
 * seed until the state stream emits, then the live projection. On construction
 * or stream failure it keeps returning the last known state. Pass `select` to
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
  return options === undefined
    ? SolidRouter.useState(router)
    : SolidRouter.useState(router, options);
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
  return SolidRouter.useNavigate(useRouter());
}

/**
 * Returns a function that dispatches a typed router command.
 *
 * @see {@link useRouterNavigate} for the common navigation case
 * @category hooks
 * @since 0.0.0
 */
export function useRouterDispatch(): (command: RouterCommand) => void {
  return SolidRouter.useDispatch(useRouter());
}
