import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    conditions: ["development", "browser"],
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["test/**/*.test.{ts,tsx}"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.vitest.json",
    },
  },
});
