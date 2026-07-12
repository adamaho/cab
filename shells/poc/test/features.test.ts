import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { Decision } from "../src/runtime/decision.ts";
import { defineCommand, defineEffect, defineEvent } from "../src/runtime/definition.ts";
import {
  defineFeature,
  makeFeatureRegistry,
  type DefinitionRegistryError,
} from "../src/runtime/feature.ts";
import type { Fact } from "../src/runtime/model.ts";
import { routerFeature } from "../src/features/router/feature.ts";
import { settingsFeature } from "../src/features/settings/feature.ts";
import { todosFeature } from "../src/features/todos/feature.ts";

function fact(name: string, args: unknown, sequence = 1): Fact {
  return {
    id: `fact-${sequence}`,
    sequence,
    name,
    version: 1,
    args,
    actor: { kind: "human", id: "tester" },
    commandId: `command-${sequence}`,
    commitId: `commit-${sequence}`,
    correlationId: `command-${sequence}`,
    causationId: `command-${sequence}`,
    branchId: "branch-root",
    branchEpoch: 0,
    at: sequence,
  };
}

const Event = defineEvent({
  name: "RegistryEvent",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
  scope: "session",
  retention: "permanent",
  render: ({ value }) => value,
});
const Command = defineCommand({
  name: "registry.command",
  description: "Registry command",
  args: Schema.Struct({ value: Schema.String }),
  exposure: "public",
  decide: (_context: never, args: { readonly value: string }) =>
    Decision.accept({ events: [Event.make(args)] }),
});
const EffectDefinition = defineEffect({
  name: "registry.effect",
  version: 1,
  description: "Registry effect",
  args: Schema.Struct({}),
  phase: "after-commit",
  replay: "never",
  authority: "client",
  concurrency: { _tag: "Every" } as const,
  run: () => Effect.void,
});

function registryFeature(name: string) {
  return defineFeature({
    name,
    initialState: { value: "initial" },
    events: [Event],
    commands: [Command],
    effects: [EffectDefinition],
    reduce: (state: { readonly value: string }, current: Fact) =>
      current.name === Event.name
        ? { value: (current.args as { readonly value: string }).value }
        : state,
  });
}

function expectRegistryFailure(
  exit: Exit.Exit<unknown, DefinitionRegistryError>,
  code: DefinitionRegistryError["code"],
) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons[0]).toMatchObject({ error: { code } });
  }
}

describe("feature folds", () => {
  it("folds relevant facts and preserves identity for irrelevant facts", () => {
    const router = routerFeature.reduce(
      routerFeature.initialState,
      fact("Navigated", {
        route: "settings",
      }),
    );
    const unchanged = routerFeature.reduce(router, fact("ThemeChanged", { theme: "dark" }, 2));

    expect(router).toEqual({ route: "settings" });
    expect(unchanged).toBe(router);
  });

  it("lets all feature reducers observe one ordered fact stream", () => {
    const journal = [
      fact("Navigated", { route: "settings" }, 1),
      fact("ThemeChanged", { theme: "dark" }, 2),
      fact("TodosFiltered", { filter: "complete" }, 3),
      fact("PageSizeChanged", { size: 25 }, 4),
    ];
    const folded = journal.reduce(
      (state, current) => ({
        router: routerFeature.reduce(state.router, current),
        settings: settingsFeature.reduce(state.settings, current),
        todos: todosFeature.reduce(state.todos, current),
      }),
      {
        router: routerFeature.initialState,
        settings: settingsFeature.initialState,
        todos: todosFeature.initialState,
      },
    );

    expect(folded).toMatchObject({
      router: { route: "settings" },
      settings: { theme: "dark", pageSize: 25 },
      todos: { filter: "complete", page: 1 },
    });
  });

  it("refolds every prefix deterministically after a structured-clone round trip", () => {
    const journal = [
      fact("TodosSorted", { by: "title" }, 1),
      fact("TodoSelected", { id: 8 }, 2),
      fact("TodoToggled", { id: 8, completed: true }, 3),
    ];
    function fold(facts: readonly Fact[]) {
      return facts.reduce(todosFeature.reduce, todosFeature.initialState);
    }

    for (let sequence = 0; sequence <= journal.length; sequence += 1) {
      expect(fold(journal.slice(0, sequence))).toEqual(
        fold(structuredClone(journal).slice(0, sequence)),
      );
    }
  });
});

describe("feature registry", () => {
  it.effect("indexes valid feature definitions", () =>
    Effect.gen(function* () {
      const registry = yield* makeFeatureRegistry([registryFeature("registry")]);

      expect(registry.featureByName.get("registry")?.initialState).toEqual({ value: "initial" });
      expect(registry.eventByName.get(Event.name)).toBe(Event);
      expect(registry.commandByName.get(Command.name)).toBe(Command);
      expect(registry.commandFeature.get(Command.name)).toBe("registry");
      expect(registry.effectByName.get(EffectDefinition.name)).toBe(EffectDefinition);
    }),
  );

  it.effect("rejects duplicate feature names", () =>
    Effect.gen(function* () {
      const first = registryFeature("duplicate");
      const second = defineFeature({ ...first, name: "duplicate" });
      expectRegistryFailure(
        yield* Effect.exit(makeFeatureRegistry([first, second])),
        "duplicate-feature",
      );
    }),
  );

  it.effect("rejects duplicate event, command, and effect names across features", () =>
    Effect.gen(function* () {
      const first = registryFeature("one");
      const secondBase = registryFeature("two");
      const duplicateEvent = defineFeature({
        ...secondBase,
        events: [Event],
        commands: [],
        effects: [],
      });
      const duplicateCommand = defineFeature({
        ...secondBase,
        events: [],
        commands: [Command],
        effects: [],
      });
      const duplicateEffect = defineFeature({
        ...secondBase,
        events: [],
        commands: [],
        effects: [EffectDefinition],
      });

      expectRegistryFailure(
        yield* Effect.exit(makeFeatureRegistry([first, duplicateEvent])),
        "duplicate-event",
      );
      expectRegistryFailure(
        yield* Effect.exit(makeFeatureRegistry([first, duplicateCommand])),
        "duplicate-command",
      );
      expectRegistryFailure(
        yield* Effect.exit(makeFeatureRegistry([first, duplicateEffect])),
        "duplicate-effect",
      );
    }),
  );

  it.effect("rejects invalid names, versions, initial state, and unsupported queues", () =>
    Effect.gen(function* () {
      const invalidName = defineFeature({ ...registryFeature("valid"), name: "" });
      expectRegistryFailure(yield* Effect.exit(makeFeatureRegistry([invalidName])), "invalid-name");

      const invalidVersionEvent = { ...Event, version: 0 };
      const invalidVersion = defineFeature({
        ...registryFeature("version"),
        events: [invalidVersionEvent],
      });
      expectRegistryFailure(
        yield* Effect.exit(makeFeatureRegistry([invalidVersion])),
        "invalid-version",
      );

      const unserializable = defineFeature({
        ...registryFeature("state"),
        initialState: { callback: () => undefined },
      });
      expectRegistryFailure(
        yield* Effect.exit(makeFeatureRegistry([unserializable])),
        "unserializable-initial-state",
      );

      const queued = defineEffect({
        ...EffectDefinition,
        name: "registry.queued",
        concurrency: { _tag: "Queue" as const, key: () => "one" },
      });
      const queueFeature = defineFeature({ ...registryFeature("queue"), effects: [queued] });
      expectRegistryFailure(
        yield* Effect.exit(makeFeatureRegistry([queueFeature])),
        "queue-unsupported",
      );
    }),
  );
});
