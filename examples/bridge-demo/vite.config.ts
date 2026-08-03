import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The rail handler runs on the Node server so no credential is ever
    // bundled into, or reachable from, the browser.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
