import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig(({ mode }) => ({
  plugins: [
    stylex.vite({
      dev: mode === "development",
      runtimeInjection: false,
      useCSSLayers: true,
    }),
    solid(),
  ],
}));
