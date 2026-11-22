import { describe, expect, it } from "vitest";
import type { Inbound } from "./types";
import { servesPlan } from "./defaults";

const base: Inbound = {
  id: "inbound-1", name: "test", protocol: "vless", port: 443, network: "tcp", minimumLevel: 0,
  multiplier: 1, enabled: true, config: {},
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("servesPlan", () => {
  it("rejects disabled inbounds and inbounds that are not provisioned for plans", () => {
    expect(servesPlan({ ...base, enabled: false }, { planId: "plan-1", planLevel: 9 })).toBe(false);
    expect(servesPlan({ ...base, planEnabled: false }, { planId: "plan-1", planLevel: 9 })).toBe(false);
  });

  it("falls back to the minimum level gate when no plan is bound", () => {
    expect(servesPlan({ ...base, minimumLevel: 3 }, { planId: "plan-1", planLevel: 2 })).toBe(false);
    expect(servesPlan({ ...base, minimumLevel: 3 }, { planId: "plan-1", planLevel: 3 })).toBe(true);
    expect(servesPlan({ ...base, minimumLevel: 3, planIds: [] }, { planId: "plan-1", planLevel: 3 })).toBe(true);
  });

  it("serves exactly the bound plans regardless of level", () => {
    const bound: Inbound = { ...base, minimumLevel: 1, planIds: ["plan-a", "plan-b"] };
    expect(servesPlan(bound, { planId: "plan-a", planLevel: 1 })).toBe(true);
    expect(servesPlan(bound, { planId: "plan-b", planLevel: 9 })).toBe(true);
    expect(servesPlan(bound, { planId: "plan-c", planLevel: 9 })).toBe(false);
    expect(servesPlan(bound, { planId: "", planLevel: 9 })).toBe(false);
  });

  it("ignores blank plan ids so an empty binding list keeps the level gate", () => {
    const bound: Inbound = { ...base, minimumLevel: 2, planIds: ["", "plan-a"] };
    expect(servesPlan(bound, { planId: "plan-a", planLevel: 0 })).toBe(true);
    expect(servesPlan(bound, { planId: "plan-b", planLevel: 9 })).toBe(false);
    expect(servesPlan({ ...base, minimumLevel: 2, planIds: [""] }, { planId: "plan-b", planLevel: 2 })).toBe(true);
  });
});
