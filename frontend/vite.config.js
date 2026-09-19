import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // dev only: the UI calls /api/* relatively, same as in production
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
});
