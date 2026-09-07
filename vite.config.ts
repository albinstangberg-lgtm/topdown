import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/** Two pages: the game, and the map editor that feeds it. */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        game: fileURLToPath(new URL("./index.html", import.meta.url)),
        editor: fileURLToPath(new URL("./editor.html", import.meta.url)),
      },
    },
  },
});
