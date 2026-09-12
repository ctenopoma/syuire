import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/**
 * Static SPA build (DESIGN.md 3, 8).
 * `base: "./"` keeps the bundle relocatable: GitHub Pages project sites and the
 * local host layer both serve it from a directory that is not the site root.
 */
export default defineConfig({
  base: "./",
  plugins: [preact()],
  resolve: {
    alias: {
      "@syuire/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
  },
});
