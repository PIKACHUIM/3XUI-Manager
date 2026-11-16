const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { getPlatformProxy } = require("wrangler");

async function ensureAssetControlFiles(configPath) {
  const assetDirectory = path.resolve(path.dirname(configPath), "dist/client");
  await mkdir(assetDirectory, { recursive: true });
  for (const name of ["_redirects", "_headers"]) {
    try {
      await writeFile(path.join(assetDirectory, name), "", { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

async function createD1TestPlatform(configPath) {
  await ensureAssetControlFiles(configPath);
  return getPlatformProxy({ configPath, envFiles: [".dev.vars"], persist: false, remoteBindings: false });
}

module.exports = { createD1TestPlatform };
