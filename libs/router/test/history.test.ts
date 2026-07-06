import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";

import { History, HistoryError, MemoryHistory, WindowHistory } from "../src/history";

describe("history", () => {
  it.effect("creates memory-backed history layers with observable state", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const program = Effect.gen(function* () {
        const history = yield* History;

        expect(yield* history.current).toBe("/");

        yield* history.push("/settings?tab=profile#details");

        expect(yield* history.current).toBe("/settings?tab=profile#details");
      });

      yield* Effect.provide(program, memory.layer);

      expect(yield* memory.current).toBe("/settings?tab=profile#details");
      expect(yield* memory.pushes).toEqual(["/settings?tab=profile#details"]);
    }),
  );

  it.effect("records memory pushes in order", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryHistory.make("/");

      const program = Effect.gen(function* () {
        const history = yield* History;

        yield* history.push("/a");
        yield* history.push("/b");
      });

      yield* Effect.provide(program, memory.layer);

      expect(yield* memory.current).toBe("/b");
      expect(yield* memory.pushes).toEqual(["/a", "/b"]);
    }),
  );

  it.effect("fails the window layer when window is unavailable", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(Effect.provide(History, WindowHistory.layer));

      expect(result._tag).toBe("Failure");

      if (result._tag === "Failure") {
        const reason = result.cause.reasons[0];

        expect(Cause.isFailReason(reason)).toBe(true);

        if (Cause.isFailReason(reason)) {
          expect(reason.error).toEqual(new HistoryError({ reason: "window-unavailable" }));
        }
      }
    }),
  );
});
