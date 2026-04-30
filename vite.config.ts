import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web/client",
  build: {
    outDir: "../../../dist/web/client",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3450"
    }
  }
});

