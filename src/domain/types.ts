export type Role = "admin" | "user";
export type PlanResetUnit = "none" | "day" | "week" | "month" | "year" | "fixed_daily" | "fixed_weekly" | "fixed_monthly";
export type NodeStatus = "online" | "offline" | "unknown";
export type SyncStatus = "pending" | "synced" | "partial" | "failed";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: string | null;
  role: Role;
  balanceMinor: number;
  planId: string;
  planLevel: number;
  planExpiresAt: string | null;
  planTrafficBytes: number;
  billedBytes: number;
  planStartedAt: string;
  trafficResetAt: string | null;
  enabled: boolean;
  inviteCode: string | null;
  invitedBy: string | null;
  inviteCount: number;
  checkinStreak: number;
  lastCheckinAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
  appliedPaymentIds?: string[];
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface Invite {
  code: string;
  createdBy: string | null;
  usedBy: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface PasswordReset {
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface Plan {
  id: string;
  name: string;
  description: string;
  group: string;
  level: number;
  trafficBytes: number;
  validityDays: number;
  resetUnit: PlanResetUnit;
  resetInterval: number;
  resetAtHour: number;
  resetWeekday: number;
  resetMonthDay: number;
  priceMinor: number;
  currency: string;
  allowPaidUpgrade: boolean;
  dodoProductId?: string;
  isDefault: boolean;
  enabled: boolean;
  /** Hidden plans stay assignable by an administrator but never appear in the user-facing catalogue. */
  hidden?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NodeRecord {
  id: string;
  name: string;
  region: string;
  /** Display order within mainland/other nodes; lower numbers come first. */
  sortIndex?: number;
  panelUrl: string;
  publicAddress: string;
  username: string;
  encryptedPassword: string;
  apiTokenEncrypted: string | null;
  basePath: string;
  status: NodeStatus;
  supportedApi: boolean | null;
  lastCheckedAt: string | null;
  inboundCount: number;
  syncStatus: SyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TrafficResetUnit = "never" | "hourly" | "daily" | "weekly" | "monthly";
export type ShareAddrStrategy = "node" | "listen" | "custom";

export interface Inbound {
  id: string;
  name: string;
  protocol: string;
  network: string;
  port: number;
  minimumLevel: number;
  multiplier: number;
  enabled: boolean;
  /** When false the inbound stays on the panel but is never provisioned for plan users. */
  planEnabled?: boolean;
  /** Plans explicitly bound to this inbound. Empty or absent keeps the legacy `minimumLevel` gate. */
  planIds?: string[];
  /** Panel listen address; an empty string means every interface. */
  listen?: string;
  /** Total traffic allowance in bytes (0 = unlimited). */
  total?: number;
  /** Panel expiry timestamp in epoch milliseconds (0 = never). */
  expiryTime?: number;
  trafficReset?: TrafficResetUnit;
  /** Day of month (1-31) used by the monthly traffic reset. */
  trafficResetDay?: number;
  tag?: string;
  shareAddrStrategy?: ShareAddrStrategy;
  shareAddr?: string;
  subSortIndex?: number;
  excludeFromSub?: boolean;
  disableFlow?: boolean;
  /** VLESS flow applied to clients provisioned for plan users. */
  defaultFlow?: string;
  /** Optional exit-node label for subscription names, e.g. a relay inbound shows its landing node. */
  exitLabel?: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface InboundNodeBinding {
  id: string;
  inboundId: string;
  nodeId: string;
  panelInboundId: number;
  createdAt: string;
}

export interface ClientMapping {
  id: string;
  userId: string;
  inboundId: string;
  email: string;
  clientId: string;
  encryptedSecret: string | null;
  flow: string;
  enable: boolean;
  syncStatus: SyncStatus;
  syncError: string | null;
  syncedNodes: string[];
  /** WireGuard peer credentials minted on first sync; unused by the other protocols. */
  wgPrivateKey?: string;
  wgPublicKey?: string;
  /** Address the peer holds inside the panel subnet, e.g. `10.0.0.2`, keyed by node ID. */
  wgAddresses?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface UsageEvent {
  id: string;
  eventId: string;
  userId: string;
  nodeId: string;
  inboundId: string;
  rawBytes: number;
  billedBytes: number;
  multiplier: number;
  occurredAt: string;
  usageDay: string;
}

export interface Order {
  id: string;
  userId: string;
  planId: string | null;
  type: "topup" | "subscription" | "upgrade";
  amountMinor: number;
  currency: string;
  provider: string;
  providerOrderId: string | null;
  checkoutUrl: string | null;
  status: "pending" | "paid" | "failed" | "expired" | "refunded";
  expiresAt: string;
  paidAt: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AppSetting {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}
