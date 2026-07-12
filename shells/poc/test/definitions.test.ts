import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Decision } from "../src/runtime/decision.ts";
import {
  defineCommand,
  defineEffect,
  defineEvent,
  StaleExecution,
} from "../src/runtime/definition.ts";
import { isSerializable } from "../src/runtime/feature.ts";

const Changed = defineEvent({
  name: "Changed",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
  scope: "session",
  retention: "permanent",
  render: ({ value }) => `changed to ${value}`,
});

const Work = defineEffect({
  name: "test.work",
  version: 2,
  description: "Do test work",
  args: Schema.Struct({ value: Schema.String }),
  phase: "after-commit",
  replay: "never",
  authority: "client",
  concurrency: { _tag: "Every" } as const,
  run: ({ value }: { readonly value: string }) => Effect.succeed(value.length),
});

const Change = defineCommand({
  name: "test.change",
  description: "Change a value",
  args: Schema.Struct({ value: Schema.String }),
  exposure: "public",
  possibleEffects: [Work.name],
  decide: (_context: never, args: { readonly value: string }) =>
    Decision.accept({ events: [Changed.make(args)], effects: [Work.make(args)] }),
});

describe("definition constructors", () => {
  it("constructs accepted decisions from serializable event and effect descriptors", () => {
    const decision = Decision.accept({
      events: [Changed.make({ value: "next" })],
      effects: [Work.make({ value: "next" })],
    });

    expect(decision).toEqual({
      _tag: "Accepted",
      events: [
        {
          _tag: "EventInvocation",
          event: "Changed",
          version: 1,
          args: { value: "next" },
        },
      ],
      effects: [
        {
          _tag: "EffectInvocation",
          effect: "test.work",
          version: 2,
          args: { value: "next" },
        },
      ],
    });
    expect(structuredClone(decision)).toEqual(decision);
    expect(isSerializable(decision)).toBe(true);
  });

  it("constructs rejection and no-op decisions without schedulable work", () => {
    expect(Decision.reject("test.denied", "Denied", { value: 1 })).toEqual({
      _tag: "Rejected",
      rejection: { code: "test.denied", message: "Denied", details: { value: 1 } },
    });
    expect(Decision.noop()).toEqual({ _tag: "Noop" });
    expect(Decision.noop("already current")).toEqual({
      _tag: "Noop",
      reason: "already current",
    });
  });

  it("preserves definition metadata and creates pure command invocations", () => {
    const invocation = Change.make({ value: "safe" });

    expect(Change).toMatchObject({
      _tag: "CommandDefinition",
      name: "test.change",
      exposure: "public",
      possibleEffects: ["test.work"],
    });
    expect(invocation).toEqual({
      _tag: "CommandInvocation",
      command: "test.change",
      args: { value: "safe" },
    });
    expect(structuredClone(invocation)).toEqual(invocation);
  });

  it.effect("does not construct or execute an Effect program when make is called", () =>
    Effect.gen(function* () {
      let runs = 0;
      const Lazy = defineEffect({
        name: "test.lazy",
        version: 1,
        description: "Remain lazy",
        args: Schema.Struct({}),
        phase: "after-commit",
        replay: "never",
        authority: "client",
        concurrency: { _tag: "Every" },
        run: () => Effect.sync(() => void (runs += 1)),
      });

      const invocation = Lazy.make({});
      expect(runs).toBe(0);
      expect(isSerializable(invocation)).toBe(true);

      yield* Lazy.run(
        {},
        {
          executionId: "execution",
          invocationId: "invocation",
          commandId: "command",
          commitId: "commit",
          correlationId: "correlation",
          actor: { kind: "system", id: "test" },
          mode: "live",
          attempt: 1,
          ensureCurrent: Effect.void,
        },
      );
      expect(runs).toBe(1);
    }),
  );
});

describe("serializability", () => {
  it("accepts finite JSON-like records and arrays", () => {
    expect(isSerializable({ text: "ok", count: 1, flags: [true, null] })).toBe(true);
    expect(isSerializable([])).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["non-finite number", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["function", () => undefined],
    ["symbol", Symbol("test")],
    ["date", new Date(0)],
  ])("rejects %s values", (_name, value) => {
    expect(isSerializable({ value })).toBe(false);
  });

  it("rejects cyclic object graphs", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isSerializable(cyclic)).toBe(false);
  });

  it("represents stale execution as a typed runtime control error", () => {
    expect(new StaleExecution("superseded")).toMatchObject({
      _tag: "StaleExecution",
      message: "superseded",
    });
  });
});
