import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wails from "@wailsio/runtime/plugins/vite";

// https://vitejs.dev/config/
export default defineConfig({
  // The editor runtime is embedded in the desktop binary rather than fetched
  // over the network. CodeMirror plus the Markdown parser intentionally lives
  // in the main offline bundle.
  build: {
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [react(), wails("./bindings")],
});
