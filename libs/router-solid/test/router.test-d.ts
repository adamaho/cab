import {
  HistoryError,
  type HistoryObservation,
  type HistoryShape,
  type MemoryHistory,
  RouterCommand,
  RouterEvent,
  type RouterState,
} from "@cab/router";
import type { Sequenced } from "@cab/store";
import type { Effect, Scope, Stream } from "effect";
import type { Accessor } from "solid-js";
import { expectTypeOf, test } from "vitest";

import {
  createBrowserRouter,
  createMemoryRouter,
  SolidRouter,
  type BrowserRouterOptions,
  type MemoryRouter as SolidMemoryRouter,
  type UseRouterStateOptions,
  useRouterDispatch,
  useRouterState,
} from "../src/index";

test("public selectors infer selected and function-valued accessors", () => {
  const hrefLength = useRouterState({ select: (state) => state.href.length });
  const functionValue = useRouterState({ select: (state) => () => state.href });

  expectTypeOf(hrefLength).toEqualTypeOf<Accessor<number>>();
  expectTypeOf(functionValue).toEqualTypeOf<Accessor<() => string>>();
  expectTypeOf(useRouterState()).toEqualTypeOf<Accessor<RouterState>>();
});

test("UseRouterStateOptions is exported with selector and equality members", () => {
  expectTypeOf<UseRouterStateOptions<number>["select"]>().toEqualTypeOf<
    (state: RouterState) => number
  >();
  expectTypeOf<UseRouterStateOptions<number>["equals"]>().toEqualTypeOf<
    ((previous: number, next: number) => boolean) | undefined
  >();
});

test("public selector equality is inferred from selected output", () => {
  useRouterState({
    select: (state) => ({ href: state.href }),
    equals: (previous, next) => {
      expectTypeOf(previous).toEqualTypeOf<{ href: string }>();
      expectTypeOf(next).toEqualTypeOf<{ href: string }>();
      return previous.href === next.href;
    },
  });
});

test("public constructors expose only supported signatures", () => {
  expectTypeOf(createBrowserRouter()).toEqualTypeOf<SolidRouter>();
  expectTypeOf(createBrowserRouter({ initialHref: "/server" })).toEqualTypeOf<SolidRouter>();
  expectTypeOf<Parameters<typeof createBrowserRouter>[0]>().toEqualTypeOf<
    BrowserRouterOptions | undefined
  >();
  expectTypeOf(createMemoryRouter({ initialHref: "/" })).toEqualTypeOf<
    Effect.Effect<SolidMemoryRouter>
  >();

  // @ts-expect-error SolidRouter construction is intentionally package-private.
  new SolidRouter();
  // @ts-expect-error SolidRouter has no public static factory.
  void SolidRouter.make;
});

test("history implementations require scoped observe and memory uses simulate", () => {
  expectTypeOf<HistoryShape["observe"]>().toEqualTypeOf<
    Effect.Effect<HistoryObservation, HistoryError, Scope.Scope>
  >();
  expectTypeOf<MemoryHistory["simulate"]>().toEqualTypeOf<(href: string) => Effect.Effect<void>>();
  expectTypeOf<HistoryShape["changes"]>().toEqualTypeOf<Stream.Stream<string>>();
});

test("journal callbacks receive sequenced router events", () => {
  const options: BrowserRouterOptions = {
    onEvent: (fact) => {
      expectTypeOf(fact).toEqualTypeOf<Sequenced<RouterEvent>>();
    },
  };

  expectTypeOf(options.onEvent).toEqualTypeOf<
    ((event: Sequenced<RouterEvent>) => void) | undefined
  >();
});

test("public dispatch remains narrowed to user commands", () => {
  const dispatch = useRouterDispatch();
  expectTypeOf(dispatch).toEqualTypeOf<(command: RouterCommand) => void>();
  expectTypeOf(
    RouterEvent.NavigationCommitted({ href: "/committed" }),
  ).not.toExtend<RouterCommand>();
  expectTypeOf(RouterCommand.NavigationRequested({ href: "/requested" })).toExtend<RouterCommand>();
});
