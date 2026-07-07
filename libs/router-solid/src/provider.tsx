import { createContext, useContext, type JSX } from "solid-js";

import { SolidRouter } from "./router";

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

const RouterContext = createContext<SolidRouter>();

/**
 * Reads the current `SolidRouter` from context.
 *
 * **Details**
 *
 * Most application code should use the focused hooks, such as
 * `useRouterState`, `useRouterNavigate`, and `useRouterDispatch`. Use this hook
 * when advanced code needs the current router instance itself. Throws a
 * descriptive error when no `RouterProvider` is mounted above the caller.
 *
 * @category hooks
 * @since 0.0.0
 */
export function useRouter(): SolidRouter {
  const router = useContext(RouterContext);

  if (router === undefined) {
    throw new Error(
      "@cab/router-solid: no router found in context. Wrap your application in <RouterProvider router={...}> with a router from createBrowserRouter() or createMemoryRouter().",
    );
  }

  return router;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

/**
 * Provides a `SolidRouter` instance to the component tree and mounts its
 * runtime lifetime.
 *
 * **Details**
 *
 * The provider mounts the router runtime atom, the public state atom, and the
 * journal observer (when the router was created with `onEvent`) for the
 * lifetime of the provider, so router state and the underlying history
 * subscription stay alive even while no component reads them. It never creates
 * an `AtomRegistry`; mount one `RegistryProvider` at the application root
 * above this provider. The `router` prop is read once at setup and must not be
 * swapped afterwards.
 *
 * @see {@link createBrowserRouter} for constructing the router instance
 * @category components
 * @since 0.0.0
 */
export function RouterProvider(props: {
  readonly router: SolidRouter;
  readonly children?: JSX.Element;
}): JSX.Element {
  const router = props.router;
  SolidRouter.mountProvider(router);

  return <RouterContext.Provider value={router}>{props.children}</RouterContext.Provider>;
}
