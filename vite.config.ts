import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

export default defineConfig(({ command }) => ({
  server: {
    port: 8080,
  },
  plugins: [
    tailwindcss(),
    // Resolves the "@/*" alias declared in tsconfig.json's `paths`.
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({ server: { entry: "server" } }),
    // `serverDir` turns on Nitro's own file-based API routes under
    // server/api/* (e.g. the email-import webhook), separate from
    // TanStack Router's page routes. The preset only matters at build time.
    nitro(command === "build" ? { preset: "vercel", serverDir: true } : { serverDir: true }),
    viteReact(),
  ],
}));
