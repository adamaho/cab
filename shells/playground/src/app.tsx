import * as stylex from "@stylexjs/stylex";
import { Effect } from "effect";

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

const label = Effect.runSync(Effect.succeed("Solid playground"));

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function App() {
  return (
    <main {...stylex.attrs(styles.shell)} aria-labelledby="playground-title">
      <section {...stylex.attrs(styles.card)}>
        <p {...stylex.attrs(styles.eyebrow)}>@cab/shell-playground</p>
        <h1 {...stylex.attrs(styles.title)} id="playground-title">
          {label}
        </h1>
        <p {...stylex.attrs(styles.description)}>Single page Solid and Effect shell.</p>
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
    maxWidth: "36rem",
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
});
