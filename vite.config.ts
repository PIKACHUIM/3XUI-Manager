import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ configPath: "wrangler.jsonc" })],
  resolve: {
    alias: {
      "mysql2/promise": new URL("./src/storage/mysql-stub.ts", import.meta.url).pathname,
    },
  },
});
