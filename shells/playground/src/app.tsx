import { RouterCommand } from "@cab/router";
import {
  createBrowserRouter,
  RouterProvider,
  useRouterDispatch,
  useRouterNavigate,
  useRouterState,
} from "@cab/router-solid";
import { RegistryProvider } from "@effect/atom-solid";
import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

const routes = [
  { href: "/", label: "Home" },
  { href: "/settings", label: "Settings" },
  { href: "/billing", label: "Billing" },
] as const;

const router = createBrowserRouter({
  onEvent: (event) => console.log("[router:event]", event),
});

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function App() {
  return (
    <RegistryProvider>
      <RouterProvider router={router}>
        <RouterDemo />
      </RouterProvider>
    </RegistryProvider>
  );
}

function RouterDemo() {
  const state = useRouterState();
  const navigate = useRouterNavigate();
  const dispatch = useRouterDispatch();

  return (
    <main {...stylex.attrs(styles.shell)} aria-labelledby="playground-title">
      <section {...stylex.attrs(styles.card)}>
        <p {...stylex.attrs(styles.eyebrow)}>@cab/shell-playground</p>
        <h1 {...stylex.attrs(styles.title)} id="playground-title">
          Router playground
        </h1>
        <p {...stylex.attrs(styles.description)}>
          Navigation wired through @cab/router-solid: RouterProvider, useRouterState,
          useRouterNavigate, and useRouterDispatch over the @cab/router core service.
        </p>

        <div {...stylex.attrs(styles.panel)} aria-live="polite">
          <span {...stylex.attrs(styles.panelLabel)}>Current href</span>
          <strong {...stylex.attrs(styles.hrefValue)}>{state().href}</strong>
        </div>

        <div {...stylex.attrs(styles.routeControls)}>
          <span {...stylex.attrs(styles.routeGroupLabel)}>useRouterNavigate()(href)</span>
          <nav {...stylex.attrs(styles.nav)} aria-label="Playground routes using navigate">
            <For each={routes}>
              {(route) => (
                <button
                  {...stylex.attrs(
                    styles.navButton,
                    state().href === route.href && styles.navButtonActive,
                  )}
                  aria-current={state().href === route.href ? "page" : undefined}
                  onClick={() => navigate(route.href)}
                  type="button"
                >
                  {route.label}
                </button>
              )}
            </For>
          </nav>

          <span {...stylex.attrs(styles.routeGroupLabel)}>useRouterDispatch()(command)</span>
          <nav {...stylex.attrs(styles.nav)} aria-label="Playground routes using dispatch">
            <For each={routes}>
              {(route) => (
                <button
                  {...stylex.attrs(
                    styles.navButton,
                    state().href === route.href && styles.navButtonActive,
                  )}
                  aria-current={state().href === route.href ? "page" : undefined}
                  onClick={() => dispatch(RouterCommand.NavigationRequested({ href: route.href }))}
                  type="button"
                >
                  {route.label}
                </button>
              )}
            </For>
          </nav>
        </div>
      </section>
    </main>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const styles = stylex.create({
  shell: {
    display: "grid",
    minHeight: "100vh",
    padding: "2rem",
    placeItems: "center",
  },
  card: {
    backgroundColor: "#fffaf2",
    borderColor: "#dfd7ca",
    borderRadius: "1.5rem",
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: "0 24px 80px rgba(76, 58, 32, 0.14)",
    maxWidth: "44rem",
    padding: "2rem",
  },
  eyebrow: {
    color: "#6e5b43",
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.12em",
    marginBlockEnd: "0.75rem",
    marginBlockStart: 0,
    textTransform: "uppercase",
  },
  title: {
    fontSize: "clamp(2rem, 8vw, 4rem)",
    lineHeight: 0.95,
    margin: 0,
  },
  description: {
    color: "#4d596a",
    fontSize: "1.125rem",
    marginBlockEnd: 0,
    marginBlockStart: "1rem",
  },
  panel: {
    backgroundColor: "#172033",
    borderRadius: "1rem",
    color: "#fffaf2",
    marginBlockStart: "2rem",
    padding: "1.25rem",
  },
  panelLabel: {
    color: "#d9c7a9",
    display: "block",
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  },
  hrefValue: {
    display: "block",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "clamp(1.75rem, 8vw, 3rem)",
    lineHeight: 1,
    marginBlockStart: "0.75rem",
    overflowWrap: "anywhere",
  },
  status: {
    color: "#b9c7db",
    fontSize: "0.875rem",
    marginBlockEnd: 0,
    marginBlockStart: "0.75rem",
  },
  routeControls: {
    display: "grid",
    gap: "0.75rem",
    marginBlockStart: "1.25rem",
  },
  routeGroupLabel: {
    color: "#6e5b43",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "0.8125rem",
    fontWeight: 700,
  },
  nav: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
  },
  navButton: {
    backgroundColor: "#ffffff",
    borderColor: "#d6cab8",
    borderRadius: "999px",
    borderStyle: "solid",
    borderWidth: 1,
    color: "#172033",
    cursor: "pointer",
    font: "inherit",
    fontWeight: 700,
    paddingBlock: "0.75rem",
    paddingInline: "1rem",
  },
  navButtonActive: {
    backgroundColor: "#e26d38",
    borderColor: "#e26d38",
    color: "#ffffff",
  },
});
