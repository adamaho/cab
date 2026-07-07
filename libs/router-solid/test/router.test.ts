import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createBrowserRouter, createMemoryRouter, SolidRouter } from "../src/router";

describe("router-solid constructors", () => {
  it.effect("creates a memory router with an inspection history handle", () =>
    Effect.gen(function* () {
      const memory = yield* createMemoryRouter({ initialHref: "/start" });

      expect(memory.router).toBeInstanceOf(SolidRouter);
      expect(yield* memory.history.current).toBe("/start");
      expect(yield* memory.history.pushes).toEqual([]);
    }),
  );

  it("creates a browser router instance synchronously", () => {
    const router = createBrowserRouter();

    expect(router).toBeInstanceOf(SolidRouter);
  });
});
