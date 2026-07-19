import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.DESIGNER_API_URL ?? "http://127.0.0.1:4310";
const webPort = Number(process.env.DESIGNER_WEB_PORT ?? 4311);

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "zustand"],
          "canvas-vendor": ["react-moveable", "react-selecto"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: {
    host: process.env.DESIGNER_WEB_HOST ?? "127.0.0.1",
    port: Number.isInteger(webPort) && webPort > 0 ? webPort : 4311,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/mcp": apiTarget,
    },
  },
});
