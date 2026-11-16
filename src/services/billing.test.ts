import { describe, expect, it } from "vitest";
import type { Plan, User } from "../domain/types";
import { createCheckout, upgradeCredit } from "./billing";

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: "current",
  name: "Current",
  description: "",
  group: "default",
  level: 1,
  trafficBytes: 1000,
  validityDays: 30,
  resetUnit: "month",
  resetInterval: 1,
  resetAtHour: 0,
  resetWeekday: 1,
  resetMonthDay: 1,
  priceMinor: 10000,
  currency: "USD",
  allowPaidUpgrade: true,
  isDefault: false,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const user = (overrides: Partial<User> = {}): User => ({
  id: "user-1",
  email: "user@example.test",
  passwordHash: "",
  emailVerifiedAt: null,
  role: "user",
  balanceMinor: 0,
  planId: "current",
  planLevel: 1,
  planExpiresAt: "2026-01-16T00:00:00.000Z",
  planTrafficBytes: 1000,
  billedBytes: 250,
  planStartedAt: "2026-01-01T00:00:00.000Z",
  trafficResetAt: null,
  enabled: true,
  inviteCode: null,
  invitedBy: null,
  inviteCount: 0,
  checkinStreak: 0,
  lastCheckinAt: null,
  lastActiveAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("upgradeCredit", () => {
  it("uses the lower remaining-validity or remaining-traffic ratio", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(upgradeCredit(plan(), user(), plan({ id: "next", priceMinor: 20000, level: 2 }), now)).toBe(5000);
  });

  it("caps credit at the new plan price and gives no credit without a valid expiry", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(upgradeCredit(plan(), user({ planExpiresAt: null, billedBytes: 0 }), plan({ id: "next", priceMinor: 4000, level: 2 }), now)).toBe(0);
    expect(upgradeCredit(plan({ validityDays: 0 }), user({ planExpiresAt: null, billedBytes: 0 }), plan({ id: "next", priceMinor: 4000, level: 2 }), now)).toBe(4000);
  });

  it("rejects a legacy non-Waffo provider before creating an order", async () => {
    const input = { type: "topup", provider: "dodo" } as never;
    await expect(createCheckout({} as never, {} as never, user(), input)).rejects.toThrow("Only Waffo checkout is supported.");
  });
});
