import { describe, expect, it } from "@effect/vitest";

import { RouterCommand, RouterEvent } from "../src/event";
import { initial, reduce } from "../src/state";

describe("router state", () => {
  it("constructs navigation commands", () => {
    expect(RouterCommand.NavigationRequested({ href: "/settings" })).toEqual({
      _tag: "NavigationRequested",
      href: "/settings",
    });
  });

  it("constructs navigation events with variant-specific payloads", () => {
    expect(
      RouterEvent.NavigationRequested({
        sequence: 0,
        href: "/settings",
      }),
    ).toEqual({
      _tag: "NavigationRequested",
      sequence: 0,
      href: "/settings",
    });

    expect(
      RouterEvent.NavigationCommitted({
        sequence: 1,
        href: "/settings",
      }),
    ).toEqual({
      _tag: "NavigationCommitted",
      sequence: 1,
      href: "/settings",
    });

    const cause = new Error("push failed");

    expect(
      RouterEvent.NavigationFailed({
        sequence: 2,
        href: "/settings",
        reason: "push-failed",
        cause,
      }),
    ).toEqual({
      _tag: "NavigationFailed",
      sequence: 2,
      href: "/settings",
      reason: "push-failed",
      cause,
    });
  });

  it("creates the initial state from the current href", () => {
    expect(initial("/")).toEqual({ href: "/" });
  });

  it("only changes state for committed navigation events", () => {
    const state = initial("/");

    expect(
      reduce(
        state,
        RouterEvent.NavigationRequested({
          sequence: 0,
          href: "/settings",
        }),
      ),
    ).toBe(state);

    expect(
      reduce(
        state,
        RouterEvent.NavigationFailed({
          sequence: 1,
          href: "/settings",
          reason: "push-failed",
        }),
      ),
    ).toBe(state);

    expect(
      reduce(
        state,
        RouterEvent.NavigationCommitted({
          sequence: 2,
          href: "/settings",
        }),
      ),
    ).toEqual({ href: "/settings" });
  });

  it("folds events into the current state projection", () => {
    const events = [
      RouterEvent.NavigationRequested({ sequence: 0, href: "/settings" }),
      RouterEvent.NavigationCommitted({ sequence: 1, href: "/settings" }),
      RouterEvent.NavigationRequested({ sequence: 2, href: "/billing" }),
      RouterEvent.NavigationFailed({
        sequence: 3,
        href: "/billing",
        reason: "push-failed",
      }),
    ];

    expect(events.reduce(reduce, initial("/"))).toEqual({ href: "/settings" });
  });
});
