import { describe, expect, it } from "@effect/vitest";

import { RouterCommand, RouterEvent, initial, RouterSlice } from "../src/slice";

describe("router slice", () => {
  it("constructs navigation commands", () => {
    expect(RouterCommand.NavigationRequested({ href: "/settings" })).toEqual({
      _tag: "NavigationRequested",
      href: "/settings",
    });
  });

  it("constructs navigation events with variant-specific payloads", () => {
    expect(RouterEvent.NavigationRequested({ href: "/settings" })).toEqual({
      _tag: "NavigationRequested",
      href: "/settings",
    });

    expect(RouterEvent.NavigationCommitted({ href: "/settings" })).toEqual({
      _tag: "NavigationCommitted",
      href: "/settings",
    });

    expect(RouterEvent.NavigationObserved({ href: "/account" })).toEqual({
      _tag: "NavigationObserved",
      href: "/account",
    });

    const cause = new Error("push failed");

    expect(
      RouterEvent.NavigationFailed({
        href: "/settings",
        reason: "push-failed",
        cause,
      }),
    ).toEqual({
      _tag: "NavigationFailed",
      href: "/settings",
      reason: "push-failed",
      cause,
    });
  });

  it("creates the initial state from the current href", () => {
    expect(initial("/")).toEqual({ href: "/" });
  });

  it("seeds router slices from the current href", () => {
    expect(RouterSlice.make("/seeded").initial).toEqual({ href: "/seeded" });
  });

  it("dedupes requested and observed navigation to the current href", () => {
    const slice = RouterSlice.make("/");

    expect(slice.decide(initial("/"), RouterCommand.NavigationRequested({ href: "/" }))).toEqual(
      [],
    );
    expect(slice.decide(initial("/"), RouterEvent.NavigationObserved({ href: "/" }))).toEqual([]);
  });

  it("decides transition rules for requested and outcome commands", () => {
    const slice = RouterSlice.make("/");
    const cause = new Error("push failed");

    expect(
      slice.decide(initial("/"), RouterCommand.NavigationRequested({ href: "/settings" })),
    ).toEqual([RouterEvent.NavigationRequested({ href: "/settings" })]);
    expect(
      slice.decide(initial("/"), RouterEvent.NavigationObserved({ href: "/account" })),
    ).toEqual([RouterEvent.NavigationObserved({ href: "/account" })]);
    expect(
      slice.decide(initial("/"), RouterEvent.NavigationCommitted({ href: "/settings" })),
    ).toEqual([RouterEvent.NavigationCommitted({ href: "/settings" })]);
    expect(
      slice.decide(
        initial("/"),
        RouterEvent.NavigationFailed({ href: "/settings", reason: "push-failed", cause }),
      ),
    ).toEqual([RouterEvent.NavigationFailed({ href: "/settings", reason: "push-failed", cause })]);
  });

  it("only changes state for committed or observed navigation events", () => {
    const slice = RouterSlice.make("/");
    const state = initial("/");

    expect(slice.reduce(state, RouterEvent.NavigationRequested({ href: "/settings" }))).toBe(state);
    expect(
      slice.reduce(
        state,
        RouterEvent.NavigationFailed({ href: "/settings", reason: "push-failed" }),
      ),
    ).toBe(state);
    expect(slice.reduce(state, RouterEvent.NavigationCommitted({ href: "/settings" }))).toEqual({
      href: "/settings",
    });
    expect(slice.reduce(state, RouterEvent.NavigationObserved({ href: "/account" }))).toEqual({
      href: "/account",
    });
  });

  it("folds events into the current state projection", () => {
    const slice = RouterSlice.make("/");
    const events = [
      RouterEvent.NavigationRequested({ href: "/settings" }),
      RouterEvent.NavigationCommitted({ href: "/settings" }),
      RouterEvent.NavigationRequested({ href: "/billing" }),
      RouterEvent.NavigationFailed({
        href: "/billing",
        reason: "push-failed",
      }),
      RouterEvent.NavigationObserved({ href: "/account" }),
    ];

    expect(events.reduce(slice.reduce, slice.initial)).toEqual({ href: "/account" });
  });
});
