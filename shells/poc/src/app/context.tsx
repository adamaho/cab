import {
  createContext,
  createEffect,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { connectBrowserMcp, type BrowserMcp } from "../agent/browser-mcp.ts";
import { refreshTodos } from "../features/ingest/feature.ts";
import {
  createSolidCabHandle,
  createSolidEffectsHandle,
  type SolidCabHandle,
  type SolidEffectsHandle,
} from "../runtime/solid.tsx";
import { createStore, type Store, type StoreAdapters } from "../store/store.ts";
import type { AppState, Fact } from "../store/types.ts";

const StoreContext = createContext<Store>();
const SolidContext = createContext<SolidCabHandle>();
const EffectContext = createContext<SolidEffectsHandle>();
const BrowserMcpContext = createContext<BrowserMcp>();

/** Owns one stable scoped runtime bridge for the mounted POC application. @category app @since 0.0.0 */
export function StoreProvider(
  props: ParentProps<{
    store?: Store;
    fetchTodos?: NonNullable<StoreAdapters["fetchTodos"]>;
  }>,
) {
  const store = props.store ?? createStore();
  if (props.fetchTodos) store.configure({ fetchTodos: props.fetchTodos });
  const bridge = createSolidCabHandle(store);
  const effects = createSolidEffectsHandle(store, bridge);
  if (store.journal().length === 0) bridge.dispatch(refreshTodos.make({}));
  bridge.start();
  const browserMcp = connectBrowserMcp(store);

  createEffect(() => {
    bridge.revision();
    bridge.acknowledge(store.renderToken());
  });

  onCleanup(() => {
    browserMcp.disconnect();
    bridge.dispose();
    void store.dispose();
  });

  return (
    <StoreContext.Provider value={store}>
      <SolidContext.Provider value={bridge}>
        <EffectContext.Provider value={effects}>
          <BrowserMcpContext.Provider value={browserMcp}>
            {props.children}
          </BrowserMcpContext.Provider>
        </EffectContext.Provider>
      </SolidContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreProvider is missing");
  return store;
}

export function useEffects(): SolidEffectsHandle {
  const effects = useContext(EffectContext);
  if (!effects) throw new Error("StoreProvider is missing");
  return effects;
}

export function useBrowserMcp(): BrowserMcp {
  const browserMcp = useContext(BrowserMcpContext);
  if (!browserMcp) throw new Error("StoreProvider is missing");
  return browserMcp;
}

export function useStoreView(): {
  state: Accessor<AppState>;
  journal: Accessor<readonly Fact[]>;
  sequence: Accessor<number>;
  revision: Accessor<number>;
} {
  const bridge = useContext(SolidContext);
  if (!bridge) throw new Error("StoreProvider is missing");
  return {
    state: bridge.state,
    journal: bridge.journal,
    sequence: bridge.sequence,
    revision: bridge.revision,
  };
}
