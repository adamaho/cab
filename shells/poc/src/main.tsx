import { render } from "solid-js/web";
import { App } from "./app/app.tsx";
import { StoreProvider } from "./app/context.tsx";
import "./styles.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing #root");
render(
  () => (
    <StoreProvider>
      <App />
    </StoreProvider>
  ),
  root,
);
