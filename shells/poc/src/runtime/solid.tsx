import { Effect } from "effect";
import { createSignal, type Accessor } from "solid-js";
import type { Actor, EffectExecution, Fact, RenderToken, RuntimeDescription } from "./model.ts";
import type { DispatchResult } from "./runtime.ts";
import type { CommandInvocation } from "./definition.ts";
import type { Store, StoreDispatchResult } from "../store/store.ts";
import type { AppState } from "../store/types.ts";

/** Is the stable Solid-facing handle over one scoped Cab runtime adapter. @category rendering @since 0.0.0 */
export interface SolidCabHandle {
  readonly state: Accessor<AppState>;
  readonly journal: Accessor<readonly Fact[]>;
  readonly sequence: Accessor<number>;
  readonly revision: Accessor<number>;
  readonly executions: Accessor<readonly EffectExecution[]>;
  readonly dispatch: <Name extends string, Args>(
    invocation: CommandInvocation<Name, Args>,
    actor?: Actor,
  ) => StoreDispatchResult | undefined;
  readonly dispatchEffect: <Name extends string, Args>(
    invocation: CommandInvocation<Name, Args>,
    actor?: Actor,
  ) => Effect.Effect<DispatchResult, unknown>;
  readonly start: () => void;
  readonly acknowledge: (token: RenderToken) => void;
  readonly dispose: () => void;
}

/** Creates one subscription and a startup-safe dispatch queue for a Solid provider. @category rendering @since 0.0.0 */
export function createSolidCabHandle(store: Store): SolidCabHandle {
  const [state, setState] = createSignal(store.state());
  const [journal, setJournal] = createSignal(store.journal());
  const [sequence, setSequence] = createSignal(store.viewingSequence());
  const [revision, setRevision] = createSignal(store.revision());
  const [executions, setExecutions] = createSignal(store.executions());
  const startupQueue: Array<() => void> = [];
  let started = false;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  function update() {
    setState(() => store.state());
    setJournal(() => store.journal());
    setSequence(store.viewingSequence());
    setRevision(store.revision());
    setExecutions(() => store.executions());
  }

  return {
    state,
    journal,
    sequence,
    revision,
    executions,
    dispatch: (invocation, actor) => {
      if (disposed) return undefined;
      if (!started) {
        startupQueue.push(() => store.dispatch(invocation, actor));
        return undefined;
      }
      return store.dispatch(invocation, actor);
    },
    dispatchEffect: store.dispatchEffect,
    start() {
      if (started || disposed) return;
      unsubscribe = store.subscribe(update);
      started = true;
      for (const queued of startupQueue.splice(0)) queued();
      update();
    },
    acknowledge: store.acknowledgeRender,
    dispose() {
      disposed = true;
      startupQueue.length = 0;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** Is the invocation-oriented effect inspection and replay surface exposed by useEffects. @category rendering @since 0.0.0 */
export interface SolidEffectsHandle {
  readonly definitions: () => RuntimeDescription["effects"];
  readonly executions: Accessor<readonly EffectExecution[]>;
  readonly replay: (invocationId: string, allow: boolean) => Promise<unknown>;
}

/** Creates a read-only effect handle; callers can replay only by committed invocation ID. @category rendering @since 0.0.0 */
export function createSolidEffectsHandle(store: Store, bridge: SolidCabHandle): SolidEffectsHandle {
  return {
    definitions: () => store.describeRuntime().effects,
    executions: bridge.executions,
    replay: store.replayEffect,
  };
}
