import type { Fact as RuntimeFact } from "../runtime/model.ts";

export type Actor = Readonly<{
  kind: "human" | "agent" | "system" | "external";
  id: string;
}>;
export type Route = "todos" | "settings" | "about";
export type Theme = "light" | "dark";
export type Filter = "all" | "complete" | "incomplete";
export type SortKey = "id" | "title" | "completed";

export interface Todo {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

/** Is the flattened compatibility view consumed by the existing POC UI. @category store @since 0.0.0 */
export interface AppState {
  readonly route: Route;
  readonly theme: Theme;
  readonly pageSize: number;
  readonly page: number;
  readonly filter: Filter;
  readonly sort: SortKey;
  readonly selectedId?: number;
  readonly toggles: Readonly<Record<number, boolean>>;
  readonly requestHash?: string;
  readonly activeRequestId?: string;
  readonly loading: boolean;
  readonly error?: string;
}

/** Is the attributed runtime fact exposed through the compatibility store view. @category store @since 0.0.0 */
export type Fact = RuntimeFact;

export const initialState: AppState = {
  route: "todos",
  theme: "light",
  pageSize: 10,
  page: 1,
  filter: "all",
  sort: "id",
  toggles: {},
  loading: false,
};
