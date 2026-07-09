import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Fiber, Stream } from "effect";

import { effect } from "../src/reactive";
import { Store } from "../src/store";
import type { Sequenced } from "../src/event";

type SettingsState = {
  readonly foo: string;
  readonly baz: string;
};

type SettingsCommand = Data.TaggedEnum<{
  FooChanged: { readonly foo: string };
  BazChanged: { readonly baz: string };
  BazChangedWithoutDedup: { readonly baz: string };
  FooAndBazChanged: { readonly foo: string; readonly baz: string };
  Touched: { readonly id: string };
}>;

const SettingsCommand = Data.taggedEnum<SettingsCommand>();

type SettingsEvent = Data.TaggedEnum<{
  FooChanged: { readonly foo: string };
  BazChanged: { readonly baz: string };
  Touched: { readonly id: string };
}>;

const SettingsEvent = Data.taggedEnum<SettingsEvent>();

const settingsInitial: SettingsState = { foo: "bar", baz: "ball" };

const settings = Store.defineSlice({
  name: "settings",
  initial: settingsInitial,
  decide: (state: SettingsState, command: SettingsCommand): ReadonlyArray<SettingsEvent> => {
    switch (command._tag) {
      case "FooChanged":
        return state.foo === command.foo ? [] : [SettingsEvent.FooChanged({ foo: command.foo })];
      case "BazChanged":
        return state.baz === command.baz ? [] : [SettingsEvent.BazChanged({ baz: command.baz })];
      case "BazChangedWithoutDedup":
        return [SettingsEvent.BazChanged({ baz: command.baz })];
      case "FooAndBazChanged":
        return [
          SettingsEvent.FooChanged({ foo: command.foo }),
          SettingsEvent.BazChanged({ baz: command.baz }),
        ];
      case "Touched":
        return [SettingsEvent.Touched({ id: command.id })];
    }
  },
  reduce: (state: SettingsState, event: SettingsEvent): SettingsState => {
    switch (event._tag) {
      case "FooChanged":
        return { ...state, foo: event.foo };
      case "BazChanged":
        return { ...state, baz: event.baz };
      case "Touched":
        return state;
    }
  },
});

type NestedState = {
  readonly settings: {
    readonly theme: {
      readonly colors: {
        readonly accent: string;
        readonly neutral: string;
      };
      readonly radius: number;
    };
  };
};

type NestedCommand = Data.TaggedEnum<{
  AccentChanged: { readonly accent: string };
  NeutralChanged: { readonly neutral: string };
  RadiusChanged: { readonly radius: number };
}>;

const NestedCommand = Data.taggedEnum<NestedCommand>();

type NestedEvent = Data.TaggedEnum<{
  AccentChanged: { readonly accent: string };
  NeutralChanged: { readonly neutral: string };
  RadiusChanged: { readonly radius: number };
}>;

const NestedEvent = Data.taggedEnum<NestedEvent>();

const nestedInitial: NestedState = {
  settings: {
    theme: {
      colors: {
        accent: "blue",
        neutral: "slate",
      },
      radius: 4,
    },
  },
};

const nested = Store.defineSlice({
  name: "nested",
  initial: nestedInitial,
  decide: (_state: NestedState, command: NestedCommand): ReadonlyArray<NestedEvent> => {
    switch (command._tag) {
      case "AccentChanged":
        return [NestedEvent.AccentChanged({ accent: command.accent })];
      case "NeutralChanged":
        return [NestedEvent.NeutralChanged({ neutral: command.neutral })];
      case "RadiusChanged":
        return [NestedEvent.RadiusChanged({ radius: command.radius })];
    }
  },
  reduce: (state: NestedState, event: NestedEvent): NestedState => {
    switch (event._tag) {
      case "AccentChanged":
        return {
          settings: {
            ...state.settings,
            theme: {
              ...state.settings.theme,
              colors: {
                ...state.settings.theme.colors,
                accent: event.accent,
              },
            },
          },
        };
      case "NeutralChanged":
        return {
          settings: {
            ...state.settings,
            theme: {
              ...state.settings.theme,
              colors: {
                ...state.settings.theme.colors,
                neutral: event.neutral,
              },
            },
          },
        };
      case "RadiusChanged":
        return {
          settings: {
            ...state.settings,
            theme: {
              ...state.settings.theme,
              radius: event.radius,
            },
          },
        };
    }
  },
});

function foldSettings(events: ReadonlyArray<Sequenced<SettingsEvent>>) {
  return events.map(({ event }) => event).reduce(settings.reduce, settings.initial);
}

function subscribeAccessor<T>(accessor: () => T, listener: (value: T) => void) {
  let initialized = false;

  return effect(() => {
    const value = accessor();

    if (initialized) {
      listener(value);
    } else {
      initialized = true;
    }
  });
}

function forkCollect<A, E>(stream: Stream.Stream<A, E>, n: number) {
  return stream
    .pipe(Stream.take(n), Stream.runCollect, Effect.forkChild)
    .pipe(Effect.tap(() => Effect.yieldNow));
}

describe("store", () => {
  it.effect("seeds snapshot from initial", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);

      expect(yield* store.state).toEqual(settingsInitial);
      expect(store.read("foo")).toBe("bar");
      expect(store.read("baz")).toBe("ball");
    }),
  );

  it.effect("dispatch appends sequenced facts and keeps folded snapshot equal to state", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);

      yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));
      expect(foldSettings(yield* store.journal)).toEqual(yield* store.state);

      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));
      expect(foldSettings(yield* store.journal)).toEqual(yield* store.state);

      const state = yield* store.state;
      const journal = yield* store.journal;

      expect(journal).toEqual([
        { sequence: 0, event: SettingsEvent.FooChanged({ foo: "next" }) },
        { sequence: 1, event: SettingsEvent.BazChanged({ baz: "bat" }) },
      ]);
      expect(foldSettings(journal)).toEqual(state);
    }),
  );

  it.effect("decide returning no events appends nothing and notifies nobody", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const values: Array<string> = [];
      const unsubscribe = store.subscribe("baz", (baz) => values.push(baz));

      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "ball" }));

      expect(yield* store.journal).toEqual([]);
      expect(values).toEqual([]);

      unsubscribe();
    }),
  );

  it.effect("does not notify a key subscriber when only another key changes", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const bazValues: Array<string> = [];
      const unsubscribe = store.subscribe("baz", (baz) => bazValues.push(baz));

      yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));

      expect(bazValues).toEqual([]);
      expect(store.read("baz")).toBe("ball");

      unsubscribe();
    }),
  );

  it.effect("a listener reading other keys does not widen its subscription", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const seen: Array<{ baz: string; foo: string }> = [];
      const unsubscribe = store.subscribe("baz", (baz) => {
        seen.push({ baz, foo: store.read("foo") });
      });

      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));
      yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));
      yield* store.dispatch(SettingsCommand.FooChanged({ foo: "later" }));

      expect(seen).toEqual([{ baz: "bat", foo: "bar" }]);

      unsubscribe();
    }),
  );

  it("keeps Effect state and read consistent during synchronous notification", () => {
    const store = Effect.runSync(Store.make(settings));
    let snapshot: SettingsState | undefined;
    let baz: string | undefined;
    const unsubscribe = store.subscribe("baz", () => {
      snapshot = Effect.runSync(store.state);
      baz = store.read("baz");
    });

    Effect.runSync(store.dispatch(SettingsCommand.BazChanged({ baz: "bat" })));

    expect(snapshot).toEqual(foldSettings(Effect.runSync(store.journal)));
    expect(snapshot).toEqual({ foo: "bar", baz: "bat" });
    expect(baz).toBe("bat");

    unsubscribe();
  });

  it.effect("allows a subscriber to defer a dispatch with queueMicrotask", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const unsubscribe = store.subscribe("baz", () => {
        queueMicrotask(() => {
          Effect.runSync(store.dispatch(SettingsCommand.FooChanged({ foo: "deferred" })));
        });
      });

      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));

      expect(store.read("foo")).toBe("deferred");
      expect(store.read("baz")).toBe("bat");

      unsubscribe();
    }),
  );

  it("applies a listener-dispatched command before the boundary dispatch returns", () => {
    const store = Effect.runSync(Store.make(settings));
    let dispatched = false;
    const unsubscribe = store.subscribe("baz", () => {
      if (!dispatched) {
        dispatched = true;
        Effect.runSync(store.dispatch(SettingsCommand.FooChanged({ foo: "cascade" })));
      }
    });

    Effect.runSync(store.dispatch(SettingsCommand.BazChanged({ baz: "bat" })));

    const journal = Effect.runSync(store.journal);
    const snapshot = Effect.runSync(store.state);

    expect(store.read("foo")).toBe("cascade");
    expect(store.read("baz")).toBe("bat");
    expect(journal).toEqual([
      { sequence: 0, event: SettingsEvent.BazChanged({ baz: "bat" }) },
      { sequence: 1, event: SettingsEvent.FooChanged({ foo: "cascade" }) },
    ]);
    expect(foldSettings(journal)).toEqual(snapshot);

    unsubscribe();
  });

  it("listener dispatch is enqueue-ack: reads after it still see pre-command state", () => {
    const store = Effect.runSync(Store.make(settings));
    let captured: string | undefined;
    const unsubscribe = store.subscribe("baz", () => {
      Effect.runSync(store.dispatch(SettingsCommand.FooChanged({ foo: "later" })));
      captured = store.read("foo");
    });

    Effect.runSync(store.dispatch(SettingsCommand.BazChanged({ baz: "bat" })));

    expect(captured).toBe("bar");
    expect(store.read("foo")).toBe("later");

    unsubscribe();
  });

  it("cascades converge when decide returns no events", () => {
    const store = Effect.runSync(Store.make(settings));
    let fired = 0;
    const unsubscribe = store.subscribe("baz", () => {
      fired += 1;
      Effect.runSync(store.dispatch(SettingsCommand.BazChanged({ baz: "bat" })));
    });

    Effect.runSync(store.dispatch(SettingsCommand.BazChanged({ baz: "bat" })));

    expect(Effect.runSync(store.journal)).toEqual([
      { sequence: 0, event: SettingsEvent.BazChanged({ baz: "bat" }) },
    ]);
    expect(fired).toBe(1);

    unsubscribe();
  });

  it("non-converging cascades fail loudly with the depth-guard defect", () => {
    const store = Effect.runSync(Store.make(settings));
    const unsubscribe = store.subscribe("baz", (baz) => {
      Effect.runSync(store.dispatch(SettingsCommand.BazChangedWithoutDedup({ baz: `${baz}x` })));
    });

    expect(() =>
      Effect.runSync(store.dispatch(SettingsCommand.BazChangedWithoutDedup({ baz: "bat" }))),
    ).toThrow(/exceeded 1000 commands without converging/);

    unsubscribe();
  });

  it("a listener throw mid-drain drops queued commands and keeps the store consistent", () => {
    const store = Effect.runSync(Store.make(settings));
    const fooValues: Array<string> = [];
    const unsubscribeFoo = store.subscribe("foo", (foo) => fooValues.push(foo));
    const unsubscribeBaz = store.subscribe("baz", (baz) => {
      if (baz === "boom") {
        Effect.runSync(store.dispatch(SettingsCommand.FooChanged({ foo: "queued" })));
        throw new Error("listener boom");
      }
    });

    expect(() =>
      Effect.runSync(store.dispatch(SettingsCommand.BazChanged({ baz: "boom" }))),
    ).toThrow(/listener boom/);

    const journalAfterThrow = Effect.runSync(store.journal);
    expect(foldSettings(journalAfterThrow)).toEqual(Effect.runSync(store.state));
    expect(store.read("foo")).toBe("bar");

    Effect.runSync(store.dispatch(SettingsCommand.FooChanged({ foo: "next" })));

    expect(store.read("foo")).toBe("next");
    expect(fooValues).toEqual(["next"]);

    unsubscribeFoo();
    unsubscribeBaz();
  });

  it.effect("notifies a key subscriber once per key change with the final value", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const bazValues: Array<string> = [];
      const unsubscribe = store.subscribe("baz", (baz) => bazValues.push(baz));

      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));

      expect(bazValues).toEqual(["bat"]);

      unsubscribe();
    }),
  );

  it.effect("does not notify when the folded key value is unchanged", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const bazValues: Array<string> = [];
      const unsubscribe = store.subscribe("baz", (baz) => bazValues.push(baz));

      yield* store.dispatch(SettingsCommand.BazChangedWithoutDedup({ baz: "ball" }));

      expect(yield* store.journal).toEqual([
        { sequence: 0, event: SettingsEvent.BazChanged({ baz: "ball" }) },
      ]);
      expect(bazValues).toEqual([]);

      unsubscribe();
    }),
  );

  it.effect("multi-event dispatch notifies each affected key once with final values", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const fooValues: Array<string> = [];
      const bazValues: Array<string> = [];
      const unsubscribeFoo = store.subscribe("foo", (foo) => fooValues.push(foo));
      const unsubscribeBaz = store.subscribe("baz", (baz) => bazValues.push(baz));

      yield* store.dispatch(SettingsCommand.FooAndBazChanged({ foo: "next", baz: "bat" }));

      expect(fooValues).toEqual(["next"]);
      expect(bazValues).toEqual(["bat"]);
      expect(yield* store.journal).toEqual([
        { sequence: 0, event: SettingsEvent.FooChanged({ foo: "next" }) },
        { sequence: 1, event: SettingsEvent.BazChanged({ baz: "bat" }) },
      ]);

      unsubscribeFoo();
      unsubscribeBaz();
    }),
  );

  it.effect("preserves unchanged-key reference identity across dispatches", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(nested);
      const settingsBefore = store.read("settings");
      const colorsBefore = settingsBefore.theme.colors;

      yield* store.dispatch(NestedCommand.RadiusChanged({ radius: 8 }));

      const settingsAfter = store.read("settings");

      expect(settingsAfter).not.toBe(settingsBefore);
      expect(settingsAfter.theme.colors).toBe(colorsBefore);
    }),
  );

  it.effect("select re-notifies only when selector output changes", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      let selectorRuns = 0;
      const selected = store.select(() => {
        selectorRuns += 1;
        return store.read("baz").toUpperCase();
      });
      const selectedValues: Array<string> = [];
      const unsubscribe = subscribeAccessor(selected, (value) => selectedValues.push(value));

      expect(selected()).toBe("BALL");
      yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));
      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));

      expect(selectorRuns).toBe(2);
      expect(selectedValues).toEqual(["BAT"]);

      unsubscribe();
    }),
  );

  it.effect("deep selectors notify only when the selected leaf changes", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(nested);
      let selectorRuns = 0;
      const accent = store.select(() => {
        selectorRuns += 1;
        return store.read("settings").theme.colors.accent;
      });
      const accentValues: Array<string> = [];
      const unsubscribe = subscribeAccessor(accent, (value) => accentValues.push(value));

      expect(accent()).toBe("blue");
      yield* store.dispatch(NestedCommand.RadiusChanged({ radius: 8 }));
      yield* store.dispatch(NestedCommand.NeutralChanged({ neutral: "zinc" }));
      yield* store.dispatch(NestedCommand.AccentChanged({ accent: "green" }));

      expect(selectorRuns).toBe(4);
      expect(accentValues).toEqual(["green"]);

      unsubscribe();
    }),
  );

  it.effect("identity folds append journal facts without state or key notifications", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const ready = yield* Deferred.make<void>();
      const statesFiber = yield* store.stateChanges.pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      const fooValues: Array<string> = [];
      const bazValues: Array<string> = [];
      const unsubscribeFoo = store.subscribe("foo", (foo) => fooValues.push(foo));
      const unsubscribeBaz = store.subscribe("baz", (baz) => bazValues.push(baz));

      yield* Deferred.await(ready);
      yield* store.dispatch(SettingsCommand.Touched({ id: "touch-1" }));

      expect(yield* store.journal).toEqual([
        { sequence: 0, event: SettingsEvent.Touched({ id: "touch-1" }) },
      ]);
      expect(yield* store.state).toBe(settingsInitial);
      expect(fooValues).toEqual([]);
      expect(bazValues).toEqual([]);

      yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));

      expect(yield* Fiber.join(statesFiber)).toEqual([
        { foo: "bar", baz: "ball" },
        { foo: "next", baz: "ball" },
      ]);
      expect(fooValues).toEqual(["next"]);
      expect(bazValues).toEqual([]);

      unsubscribeFoo();
      unsubscribeBaz();
    }),
  );

  it.effect("stateChanges emits the seeded snapshot and each changed folded snapshot", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const ready = yield* Deferred.make<void>();
      const statesFiber = yield* store.stateChanges.pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(ready);
      yield* store.dispatch(SettingsCommand.FooChanged({ foo: "next" }));
      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));

      expect(yield* Fiber.join(statesFiber)).toEqual([
        { foo: "bar", baz: "ball" },
        { foo: "next", baz: "ball" },
        { foo: "next", baz: "bat" },
      ]);
    }),
  );

  it.effect("unsubscribe stops notifications", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const bazValues: Array<string> = [];
      const unsubscribe = store.subscribe("baz", (baz) => bazValues.push(baz));

      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));
      unsubscribe();
      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bag" }));

      expect(bazValues).toEqual(["bat"]);
    }),
  );

  it("dispatch is runSync-safe and subscribers fire before dispatch returns", () => {
    const store = Effect.runSync(Store.make(settings));
    const bazValues: Array<string> = [];
    const unsubscribe = store.subscribe("baz", (baz) => bazValues.push(baz));

    Effect.runSync(store.dispatch(SettingsCommand.BazChanged({ baz: "bat" })));

    expect(bazValues).toEqual(["bat"]);

    unsubscribe();
  });

  it.effect("journalChanges streams live appended facts", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const eventsFiber = yield* forkCollect(store.journalChanges, 2);

      yield* store.dispatch(SettingsCommand.FooAndBazChanged({ foo: "next", baz: "bat" }));

      expect(yield* Fiber.join(eventsFiber)).toEqual([
        { sequence: 0, event: SettingsEvent.FooChanged({ foo: "next" }) },
        { sequence: 1, event: SettingsEvent.BazChanged({ baz: "bat" }) },
      ]);
    }),
  );

  it.effect("concurrent dispatches serialize with gapless monotonic sequences", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);
      const first = yield* store
        .dispatch(SettingsCommand.FooChanged({ foo: "a" }))
        .pipe(Effect.forkChild);
      const second = yield* store
        .dispatch(SettingsCommand.BazChanged({ baz: "b" }))
        .pipe(Effect.forkChild);

      yield* Fiber.join(first);
      yield* Fiber.join(second);

      expect((yield* store.journal).map(({ sequence }) => sequence)).toEqual([0, 1]);
      expect(foldSettings(yield* store.journal)).toEqual(yield* store.state);
    }),
  );

  it.effect("reader exposes reads and journal but no dispatch", () =>
    Effect.gen(function* () {
      const store = yield* Store.make(settings);

      yield* store.dispatch(SettingsCommand.BazChanged({ baz: "bat" }));

      expect(store.reader.read("baz")).toBe("bat");
      expect(yield* store.reader.state).toEqual({ foo: "bar", baz: "bat" });
      expect(yield* store.reader.journal).toEqual([
        { sequence: 0, event: SettingsEvent.BazChanged({ baz: "bat" }) },
      ]);
      expect("dispatch" in store.reader).toBe(false);
    }),
  );
});
