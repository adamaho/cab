import { expectTypeOf, test } from "vitest";
import type { Layer } from "effect";

import type { History, HistoryError } from "../src/history";
import { Router, RouterModel, type RouterShape } from "../src/router";
import { RouterEvent, type RouterCommand } from "../src/slice";

test("public dispatch accepts only user-originated router commands", () => {
  expectTypeOf<Parameters<RouterShape["dispatch"]>[0]>().toEqualTypeOf<RouterCommand>();
  expectTypeOf(
    RouterEvent.NavigationCommitted({ href: "/settings" }),
  ).not.toExtend<RouterCommand>();
  expectTypeOf(RouterEvent.NavigationObserved({ href: "/settings" })).not.toExtend<RouterCommand>();
});

test("model-backed layers preserve router error requirements", () => {
  const model = RouterModel.make("/");

  expectTypeOf(Router.layerFromModel(model)).toEqualTypeOf<
    Layer.Layer<Router, HistoryError, History>
  >();
  expectTypeOf(Router.layerBrowserFromModel(model)).toEqualTypeOf<
    Layer.Layer<Router, HistoryError>
  >();
});
