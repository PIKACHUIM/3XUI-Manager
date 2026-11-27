import { build } from "esbuild";

await build({
  entryPoints: ["src/platform/esa.ts"],
  outfile: "dist/esa-entry.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  external: ["@edgeone/pages-blob", "mysql2/promise"],
});
