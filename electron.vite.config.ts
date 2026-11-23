import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        external: ["electron"],
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: {
          shell: resolve(__dirname, "src/preload/shell.ts"),
          tabbar: resolve(__dirname, "src/preload/tabbar.ts"),
          settings: resolve(__dirname, "src/preload/settings.ts"),
          notification: resolve(__dirname, "src/preload/notification.ts"),
        },
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          splash: resolve(__dirname, "src/renderer/splash/index.html"),
          tabbar: resolve(__dirname, "src/renderer/tabbar/index.html"),
          settings: resolve(__dirname, "src/renderer/settings/index.html"),
        },
      },
    },
  },
});
