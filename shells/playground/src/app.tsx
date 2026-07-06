import { RegistryProvider, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-solid";
import {
  Router,
  routerRuntimeAtom,
  routerStateAtom,
  type RouterEvent,
  type RouterState,
} from "@cab/router";
import * as stylex from "@stylexjs/stylex";
import { Cause, Effect } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { For } from "solid-js";

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

const routes = [
  { href: "/", label: "Home" },
  { href: "/settings", label: "Settings" },
  { href: "/billing", label: "Billing" },
] as const;

let loggedEventCount = 0;

const navigateAndLogAtom = routerRuntimeAtom.fn<string>()((href: string) =>
  Effect.gen(function* () {
    const router = yield* Router;

    yield* router.navigate(href);

    const events = yield* router.events;
    logNewEvents(events);
  }),
);

function hrefFrom(result: AsyncResult.AsyncResult<RouterState, unknown>) {
  return AsyncResult.isSuccess(result) ? result.value.href : "loading...";
}

function statusFrom(result: AsyncResult.AsyncResult<RouterState, unknown>) {
  if (AsyncResult.isSuccess(result)) {
    return "Router state is live.";
  }

  if (AsyncResult.isFailure(result)) {
    return Cause.pretty(result.cause);
  }

  return "Starting router runtime...";
}

function logNewEvents(events: ReadonlyArray<RouterEvent>) {
  for (const event of events.slice(loggedEventCount)) {
    console.log("[router:event]", event);
  }

  loggedEventCount = events.length;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function App() {
  return (
    <RegistryProvider>
      <RouterDemo />
    </RegistryProvider>
  );
}

function RouterDemo() {
  useAtomMount(() => routerRuntimeAtom);

  const state = useAtomValue(() => routerStateAtom);
  const navigate = useAtomSet(() => navigateAndLogAtom);

  return (
    <main {...stylex.attrs(styles.shell)} aria-labelledby="playground-title">
      <section {...stylex.attrs(styles.card)}>
        <p {...stylex.attrs(styles.eyebrow)}>@cab/shell-playground</p>
        <h1 {...stylex.attrs(styles.title)} id="playground-title">
          Router playground
        </h1>
        <p {...stylex.attrs(styles.description)}>
          Programmatic navigation wired through @cab/router, Effect atoms, and
          window.history.pushState.
        </p>

        <div {...stylex.attrs(styles.panel)} aria-live="polite">
          <span {...stylex.attrs(styles.panelLabel)}>Current href</span>
          <strong {...stylex.attrs(styles.hrefValue)}>{hrefFrom(state())}</strong>
          <p {...stylex.attrs(styles.status)}>{statusFrom(state())}</p>
        </div>

        <nav {...stylex.attrs(styles.nav)} aria-label="Playground routes">
          <For each={routes}>
            {(route) => (
              <button
                {...stylex.attrs(
                  styles.navButton,
                  hrefFrom(state()) === route.href && styles.navButtonActive,
                )}
                aria-current={hrefFrom(state()) === route.href ? "page" : undefined}
                onClick={() => navigate(route.href)}
                type="button"
              >
                {route.label}
              </button>
            )}
          </For>
        </nav>
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
  nav: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
    marginBlockStart: "1.25rem",
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
