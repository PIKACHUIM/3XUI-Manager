import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, generateWireGuardKeys, wireGuardPublicKey } from "./wireguard";

describe("WireGuard keys", () => {
  it("matches the RFC 7748 X25519 and wg(8) public key vectors", () => {
    expect(wireGuardPublicKey("dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=")).toBe("hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=");
    expect(wireGuardPublicKey("yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=")).toBe("HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=");
  });

  it("round-trips base64 and mints distinct 32-byte key pairs", () => {
    const bytes = Uint8Array.of(0, 1, 127, 128, 255);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    const first = generateWireGuardKeys();
    const second = generateWireGuardKeys();
    expect(base64ToBytes(first.privateKey)).toHaveLength(32);
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(wireGuardPublicKey(first.privateKey)).toBe(first.publicKey);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => wireGuardPublicKey(bytesToBase64(Uint8Array.of(1, 2, 3)))).toThrow(/32 bytes/);
  });
});
