import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("edge-functions/api", { recursive: true });
await build({
  entryPoints: ["src/platform/edgeone.ts"],
  outfile: "edge-functions/api/[[default]].js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  external: ["mysql2/promise"],
});
