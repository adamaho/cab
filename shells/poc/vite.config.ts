import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  server: {
    allowedHosts: ["winston.tail8b4a67.ts.net"],
    host: "0.0.0.0",
  },
});
