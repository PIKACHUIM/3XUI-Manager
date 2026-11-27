/** Cloudflare/Edge builds must not include the Node-only mysql2 package. */
export function createPool(): never {
  throw new Error("MySQL storage requires a Node.js runtime.");
}
