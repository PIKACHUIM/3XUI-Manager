import { describe, expect, it } from "vitest";
import type { Inbound, InboundNodeBinding, NodeRecord } from "./types";
import { compareNodes, isMainlandNode, mainlandInboundIds, servesPlan, validSortIndex } from "./defaults";

const base: Inbound = {
  id: "inbound-1", name: "test", protocol: "vless", port: 443, network: "tcp", minimumLevel: 0,
  multiplier: 1, enabled: true, config: {},
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("display order", () => {
  it("recognizes mainland locations without classifying Taiwan, Hong Kong or Macau as mainland", () => {
    for (const region of ["江苏镇江", "西安", "中國大陸", "CN", "上海", "Shaanxi"]) {
      expect(isMainlandNode({ name: "node", region })).toBe(true);
    }
    for (const region of ["台湾", "中國香港", "澳门", "Taiwan", "Hong Kong", "东京", "Frankfurt"]) expect(isMainlandNode({ name: "node", region })).toBe(false);
    expect(isMainlandNode({ name: "江苏镇江1", region: "" })).toBe(true);
  });
  it("sorts mainland first, supports legacy records and uses numeric name ties", () => {
    const rows = [
      { id: "jp10", name: "日本东京10", region: "东京" },
      { id: "jp2", name: "日本东京2", region: "东京" },
      { id: "js", name: "江苏镇江1", region: "江苏", sortIndex: 2 },
      { id: "xa", name: "陕西西安1", region: "西安", sortIndex: 1 },
    ];
    expect(rows.sort(compareNodes).map((row) => row.id)).toEqual(["xa", "js", "jp2", "jp10"]);
  });
  it("classifies bound inbounds rather than guessing their names", () => {
    const nodes = [{ id: "cn", name: "镇江", region: "江苏" }, { id: "jp", name: "东京", region: "日本" }] as NodeRecord[];
    const bindings = [{ inboundId: "cn-only", nodeId: "cn" }, { inboundId: "mixed", nodeId: "cn" }, { inboundId: "mixed", nodeId: "jp" }] as InboundNodeBinding[];
    expect([...mainlandInboundIds(bindings, nodes)]).toEqual(["cn-only"]);
  });
  it("only accepts integer sort indexes within the allowed range", () => {
    for (const value of [0, 1, 9999]) expect(validSortIndex(value)).toBe(true);
    for (const value of [-1, 10000, 1.5, "1", null, undefined, NaN, Infinity]) expect(validSortIndex(value)).toBe(false);
  });
});

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
