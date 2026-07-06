import { Effect } from "effect";

const label = Effect.runSync(Effect.succeed("Solid playground"));

/**
 * Renders the playground shell landing page.
 *
 * @returns Minimal shell page content.
 */
export function App() {
  return (
    <main class="playground-shell" aria-labelledby="playground-title">
      <section class="playground-card">
        <p class="playground-eyebrow">@cab/shell-playground</p>
        <h1 id="playground-title">{label}</h1>
        <p>Single page Solid and Effect shell.</p>
      </section>
    </main>
  );
}
