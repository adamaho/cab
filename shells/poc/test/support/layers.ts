import { Effect, Layer, Ref } from "effect";
import { JournalMemoryLive } from "../../src/runtime/journal.ts";
import { QueryCacheEmpty } from "../../src/runtime/query.ts";
import {
  IdGenerator,
  RenderCoordinatorLive,
  RuntimeClock,
  RuntimeSupervisor,
  type SupervisorReport,
} from "../../src/runtime/services.ts";

/** Deterministic runtime dependencies and inspectable supervisor state for focused tests. */
export function makeRuntimeTestLayers() {
  const reportsRef = Ref.makeUnsafe<readonly SupervisorReport[]>([]);
  let id = 0;
  let now = 1000;

  return {
    layer: Layer.mergeAll(
      JournalMemoryLive,
      QueryCacheEmpty,
      RenderCoordinatorLive,
      Layer.succeed(IdGenerator, {
        next: (kind) => Effect.sync(() => `${kind}-test-${++id}`),
      }),
      Layer.succeed(RuntimeClock, {
        now: Effect.sync(() => ++now),
      }),
      Layer.succeed(RuntimeSupervisor, {
        report: (report) => Ref.update(reportsRef, (reports) => [...reports, report]),
      }),
    ),
    reports: Ref.get(reportsRef),
  } as const;
}
