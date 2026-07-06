import { render } from "solid-js/web";

import { App } from "./App";
import "./styles.css";

const root = document.querySelector("#root");

if (root === null) {
  throw new Error("Root element not found.");
}

render(() => <App />, root);
