import type { Plan, UsageEvent, User } from "../domain/types";
import type { DocumentStore, ListOptions, Page } from "./store";

export interface TrafficSampleInput {
  userId: string;
  nodeId: string;
  inboundId: string;
  clientKey: string;
  totalBytes: number;
  multiplier: number;
  occurredAt: string;
  usageDay: string;
}

interface TrafficCounterRow {
  client_key: string;
  epoch: number;
  last_total_bytes: number;
  multiplier: number;
}

interface PendingUsageRow {
  event_id: string;
  user_id: string;
  node_id: string;
  inbound_id: string;
  raw_bytes: number;
  billed_bytes: number;
  multiplier: number;
  occurred_at: string;
  usage_day: string;
}

export function calculateTrafficDelta(previous: Pick<TrafficCounterRow, "epoch" | "last_total_bytes" | "multiplier"> | null, totalBytes: number, multiplier: number): { epoch: number; deltaBytes: number; billedBytes: number } {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || !Number.isFinite(multiplier) || multiplier < 0) throw new Error("Traffic sample values are invalid.");
  const reset = previous !== null && totalBytes < previous.last_total_bytes;
  const multiplierChanged = previous !== null && multiplier !== previous.multiplier;
  const epoch = (previous?.epoch ?? 0) + (reset ? 1 : 0);
  const deltaBytes = !previous || multiplierChanged ? 0 : reset ? totalBytes : totalBytes - previous.last_total_bytes;
  const billedBytes = Math.ceil(deltaBytes * multiplier);
  if (!Number.isSafeInteger(billedBytes)) throw new Error("Billed traffic delta exceeds the safe integer range.");
  return { epoch, deltaBytes, billedBytes };
}

interface StoredRecord {
  document: string;
}

const patchableUserFields = new Set([
  "emailVerifiedAt", "role", "balanceMinor", "planId", "planLevel", "planExpiresAt", "planTrafficBytes",
  "billedBytes", "planStartedAt", "trafficResetAt", "enabled", "inviteCount", "checkinStreak", "lastCheckinAt",
  "passwordHash", "lastActiveAt", "updatedAt", "appliedPaymentIds",
]);

export class D1Store implements DocumentStore {
  constructor(private readonly db: Env["DB"]) {}

  async get<T>(collection: string, id: string): Promise<T | null> {
    const row = await this.db.prepare("SELECT document FROM app_records WHERE collection = ? AND record_id = ?")
      .bind(collection, id).first<StoredRecord>();
    if (!row) return null;
    return JSON.parse(row.document) as T;
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    await this.db.prepare(`INSERT INTO app_records(collection, record_id, document, created_at, updated_at)
      VALUES(?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(collection, record_id) DO UPDATE SET document = excluded.document, updated_at = CURRENT_TIMESTAMP`)
      .bind(collection, id, JSON.stringify(value)).run();
  }

  async patchUser(id: string, patch: Partial<User>): Promise<User | null> {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (fields.some(([key]) => !patchableUserFields.has(key))) throw new Error("User patch contains an unsupported field.");
    if (!fields.some(([key]) => key === "updatedAt")) fields.push(["updatedAt", new Date().toISOString()]);
    const setters = fields.map(() => "?, json(?)").join(", ");
    const bindings = fields.flatMap(([key, value]) => [`$.${key}`, JSON.stringify(value) ?? "null"]);
    const row = await this.db.prepare(`UPDATE app_records SET document = json_set(document, ${setters}), updated_at = CURRENT_TIMESTAMP
      WHERE collection = 'users' AND record_id = ? RETURNING document`)
      .bind(...bindings, id).first<StoredRecord>();
    return row ? JSON.parse(row.document) as User : null;
  }

  private async applyBalanceDeltaOnce(input: {
    ledgerId: string;
    kind: string;
    userId: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    createdAt: string;
    direction: 1 | -1;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("Balance movements must be positive safe integers.");
    const document = JSON.stringify({
      id: input.ledgerId, userId: input.userId, orderId: input.orderId, kind: input.kind,
      amountMinor: input.direction * input.amountMinor, currency: input.currency, idempotencyKey: input.ledgerId, createdAt: input.createdAt,
    });
    const debit = input.direction < 0;
    const delta = debit ? " - ?" : " + ?";
    const balanceGuard = debit ? " AND CAST(COALESCE(json_extract(document, '$.balanceMinor'), 0) AS INTEGER) >= ?" : "";
    const insert = this.db.prepare(`INSERT OR IGNORE INTO app_records(collection, record_id, document, created_at, updated_at)
      SELECT 'ledger-entries', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM app_records WHERE collection = 'users' AND record_id = ?${balanceGuard})`);
    const update = this.db.prepare(`UPDATE app_records SET document = json_set(document,
        '$.balanceMinor', CAST(COALESCE(json_extract(document, '$.balanceMinor'), 0) AS INTEGER)${delta},
        '$.updatedAt', ?), updated_at = CURRENT_TIMESTAMP
      WHERE collection = 'users' AND record_id = ? AND changes() = 1`);
    const results = await this.db.batch([
      debit ? insert.bind(input.ledgerId, document, input.userId, input.amountMinor) : insert.bind(input.ledgerId, document, input.userId),
      update.bind(input.amountMinor, input.createdAt, input.userId),
    ]);
    return (results[1]?.meta.changes ?? 0) === 1;
  }

  async creditUserBalanceOnce(input: { userId: string; orderId: string; amountMinor: number; currency: string; createdAt: string }): Promise<boolean> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("Referral credit must be a positive safe integer.");
    return this.applyBalanceDeltaOnce({
      ledgerId: `referral:${input.orderId}`, kind: "referral_reward", userId: input.userId, orderId: input.orderId,
      amountMinor: input.amountMinor, currency: input.currency, createdAt: input.createdAt, direction: 1,
    });
  }

  async debitUserBalanceOnce(input: { userId: string; orderId: string; amountMinor: number; currency: string; createdAt: string; kind?: "balance_payment" | "balance_recharge" }): Promise<boolean> {
    const kind = input.kind ?? "balance_payment";
    return this.applyBalanceDeltaOnce({
      ledgerId: `${kind === "balance_recharge" ? "balance-recharge" : "balance-payment"}:${input.orderId}`, kind,
      userId: input.userId, orderId: input.orderId, amountMinor: input.amountMinor,
      currency: input.currency, createdAt: input.createdAt, direction: -1,
    });
  }

  async refundUserBalanceOnce(input: { userId: string; orderId: string; amountMinor: number; currency: string; createdAt: string }): Promise<boolean> {
    return this.applyBalanceDeltaOnce({
      ledgerId: `balance-refund:${input.orderId}`, kind: "balance_refund", userId: input.userId, orderId: input.orderId,
      amountMinor: input.amountMinor, currency: input.currency, createdAt: input.createdAt, direction: 1,
    });
  }

  /** Applies an administrator's manual credit or deduction exactly once per manual order. */
  async adjustUserBalanceOnce(input: { userId: string; orderId: string; amountMinor: number; currency: string; createdAt: string; action: "credit" | "refund" }): Promise<boolean> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("Manual adjustments must be positive safe integers.");
    const credit = input.action === "credit";
    return this.applyBalanceDeltaOnce({
      ledgerId: `${credit ? "manual-credit" : "manual-refund"}:${input.orderId}`,
      kind: credit ? "manual_credit" : "manual_refund",
      userId: input.userId, orderId: input.orderId, amountMinor: input.amountMinor,
      currency: input.currency, createdAt: input.createdAt, direction: credit ? 1 : -1,
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM app_records WHERE collection = ? AND record_id = ?").bind(collection, id).run();
  }

  async list<T>(collection: string, options: ListOptions = {}): Promise<Page<T>> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const after = options.cursor ?? "";
    const prefixCondition = options.prefix === undefined ? "" : " AND substr(record_id, 1, length(?)) = ?";
    const statement = this.db.prepare(`SELECT record_id, document FROM app_records
      WHERE collection = ? AND record_id > ?${prefixCondition} ORDER BY record_id LIMIT ?`);
    const rows = await (options.prefix === undefined
      ? statement.bind(collection, after, limit + 1)
      : statement.bind(collection, after, options.prefix, options.prefix, limit + 1))
      .all<{ record_id: string; document: string }>();
    const result = rows.results ?? [];
    const hasMore = result.length > limit;
    const page = result.slice(0, limit);
    return { items: page.map((row) => JSON.parse(row.document) as T), cursor: hasMore ? page.at(-1)?.record_id ?? null : null };
  }

  async has(collection: string, id: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 AS found FROM app_records WHERE collection = ? AND record_id = ?")
      .bind(collection, id).first<{ found: number }>();
    return row !== null;
  }

  /**
   * Resolves a subscription token in a single round trip: the token index, the credential that must
   * still carry the same hash, the account and its plan. Done one query at a time this is four round
   * trips, which dominates the latency of every subscription refresh.
   */
  async readSubscriptionAccess(tokenHash: string): Promise<{ user: User; plan: Plan | null } | null> {
    const owner = "SELECT json_extract(document, '$.userId') FROM app_records WHERE collection = 'subscription-token-index' AND record_id = ?";
    const [credential, account, plan] = await this.db.batch<{ document: string }>([
      this.db.prepare(`SELECT document FROM app_records WHERE collection = 'subscription-credentials' AND record_id = (${owner})`).bind(tokenHash),
      this.db.prepare(`SELECT document FROM app_records WHERE collection = 'users' AND record_id = (${owner})`).bind(tokenHash),
      this.db.prepare(`SELECT document FROM app_records WHERE collection = 'plans' AND record_id = (
        SELECT json_extract(document, '$.planId') FROM app_records WHERE collection = 'users' AND record_id = (${owner})
      )`).bind(tokenHash),
    ]);
    const credentialRow = credential?.results?.[0];
    const userRow = account?.results?.[0];
    if (!credentialRow || !userRow) return null;
    const credentialRecord = JSON.parse(credentialRow.document) as { tokenHash?: unknown };
    if (credentialRecord.tokenHash !== tokenHash) return null;
    const planRow = plan?.results?.[0];
    return {
      user: JSON.parse(userRow.document) as User,
      plan: planRow ? JSON.parse(planRow.document) as Plan : null,
    };
  }

  async acquireLease(name: string, owner: string, expiresAt: number): Promise<boolean> {
    const currentTime = Date.now();
    const result = await this.db.prepare(`INSERT INTO job_leases(job_name, lease_id, lease_until, cursor, updated_at)
      VALUES(?, ?, ?, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(job_name) DO UPDATE SET lease_id = excluded.lease_id, lease_until = excluded.lease_until, updated_at = CURRENT_TIMESTAMP
      WHERE job_leases.lease_until <= ?`)
      .bind(name, owner, expiresAt, currentTime).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseLease(name: string, owner: string): Promise<void> {
    await this.db.prepare("DELETE FROM job_leases WHERE job_name = ? AND lease_id = ?").bind(name, owner).run();
  }

  async recordTrafficSample(input: TrafficSampleInput): Promise<UsageEvent | null> {
    return (await this.recordTrafficSamples([input]))[0] ?? null;
  }

  async recordTrafficSamples(inputs: TrafficSampleInput[]): Promise<UsageEvent[]> {
    if (inputs.length === 0) return [];
    for (const input of inputs) {
      if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0 || !Number.isFinite(input.multiplier) || input.multiplier < 0) throw new Error("Traffic sample values are invalid.");
    }
    const groups = new Map<string, TrafficSampleInput[]>();
    for (const input of inputs) {
      const key = JSON.stringify([input.nodeId, input.inboundId]);
      const group = groups.get(key) ?? [];
      group.push(input);
      groups.set(key, group);
    }
    const deltaBytesSql = `CASE
      WHEN excluded.multiplier <> traffic_counters.multiplier THEN 0
      WHEN excluded.last_total_bytes < traffic_counters.last_total_bytes THEN excluded.last_total_bytes
      ELSE excluded.last_total_bytes - traffic_counters.last_total_bytes
    END`;
    const billedBytesSql = `CASE
      WHEN excluded.multiplier <> traffic_counters.multiplier THEN 0
      ELSE CAST((${deltaBytesSql}) * excluded.multiplier AS INTEGER)
        + CASE WHEN ((${deltaBytesSql}) * excluded.multiplier) > CAST((${deltaBytesSql}) * excluded.multiplier AS INTEGER) THEN 1 ELSE 0 END
    END`;
    const recorded: UsageEvent[] = [];
    for (const samples of groups.values()) {
      for (let offset = 0; offset < samples.length; offset += 50) {
        const statements: D1PreparedStatement[] = [];
        const eventStatementIndexes: number[] = [];
        for (const input of samples.slice(offset, offset + 50)) {
          const counterBaseId = [input.nodeId, input.inboundId, input.clientKey].map(encodeURIComponent).join(":");
          const eventId = `${counterBaseId}:${encodeURIComponent(input.occurredAt)}:${input.totalBytes}`;
          statements.push(this.db.prepare(`INSERT INTO traffic_counters(
              counter_id, node_id, inbound_id, client_key, epoch, last_total_bytes, last_sampled_at, multiplier,
              last_event_id, last_delta_bytes, last_billed_bytes
            )
            SELECT ? || ':' || COALESCE(MAX(epoch), 0), ?, ?, ?, COALESCE(MAX(epoch), 0), ?, ?, ?, ?, 0, 0
            FROM traffic_counters WHERE node_id = ? AND inbound_id = ? AND client_key = ?
            ON CONFLICT(node_id, inbound_id, client_key, epoch) DO UPDATE SET
              counter_id = ? || ':' || (traffic_counters.epoch + CASE WHEN excluded.last_total_bytes < traffic_counters.last_total_bytes THEN 1 ELSE 0 END),
              epoch = traffic_counters.epoch + CASE WHEN excluded.last_total_bytes < traffic_counters.last_total_bytes THEN 1 ELSE 0 END,
              last_total_bytes = excluded.last_total_bytes,
              last_sampled_at = excluded.last_sampled_at,
              multiplier = excluded.multiplier,
              last_event_id = excluded.last_event_id,
              last_delta_bytes = ${deltaBytesSql},
              last_billed_bytes = ${billedBytesSql}
            WHERE excluded.last_sampled_at > traffic_counters.last_sampled_at
              OR (excluded.last_sampled_at = traffic_counters.last_sampled_at AND excluded.last_total_bytes > traffic_counters.last_total_bytes)`)
            .bind(counterBaseId, input.nodeId, input.inboundId, input.clientKey, input.totalBytes, input.occurredAt, input.multiplier, eventId,
              input.nodeId, input.inboundId, input.clientKey, counterBaseId));
          statements.push(this.db.prepare(`INSERT OR IGNORE INTO usage_events(
              event_id, user_id, node_id, inbound_id, raw_bytes, billed_bytes, multiplier, occurred_at, usage_day
            )
            SELECT ?, ?, ?, ?, last_delta_bytes, last_billed_bytes, ?, ?, ? FROM traffic_counters
            WHERE node_id = ? AND inbound_id = ? AND client_key = ? AND last_event_id = ? AND last_delta_bytes > 0
            RETURNING event_id, user_id, node_id, inbound_id, raw_bytes, billed_bytes, multiplier, occurred_at, usage_day`)
            .bind(eventId, input.userId, input.nodeId, input.inboundId, input.multiplier, input.occurredAt, input.usageDay,
              input.nodeId, input.inboundId, input.clientKey, eventId));
          eventStatementIndexes.push(statements.length - 1);
        }
        const results = await this.db.batch(statements);
        for (const index of eventStatementIndexes) {
          const rows = (results[index]?.results ?? []) as Array<{
            event_id: string;
            user_id: string;
            node_id: string;
            inbound_id: string;
            raw_bytes: number;
            billed_bytes: number;
            multiplier: number;
            occurred_at: string;
            usage_day: string;
          }>;
          recorded.push(...rows.map((row) => ({
            id: row.event_id,
            eventId: row.event_id,
            userId: row.user_id,
            nodeId: row.node_id,
            inboundId: row.inbound_id,
            rawBytes: row.raw_bytes,
            billedBytes: row.billed_bytes,
            multiplier: row.multiplier,
            occurredAt: row.occurred_at,
            usageDay: row.usage_day,
          })));
        }
      }
    }
    return recorded;
  }

  async applyPendingUsageEvents(limit = 100): Promise<{ events: UsageEvent[]; unapplied: number }> {
    const boundedLimit = Math.min(Math.max(limit, 1), 250);
    const rows = await this.db.prepare(`SELECT event_id, user_id, node_id, inbound_id, raw_bytes, billed_bytes, multiplier, occurred_at, usage_day
      FROM usage_events WHERE applied_at IS NULL ORDER BY occurred_at, event_id LIMIT ?`)
      .bind(boundedLimit).all<PendingUsageRow>();
    const pending = rows.results ?? [];
    if (pending.length === 0) return { events: [], unapplied: 0 };
    const statements: D1PreparedStatement[] = [];
    const appliedAt = new Date().toISOString();
    for (const row of pending) {
      const eventExists = "EXISTS (SELECT 1 FROM usage_events WHERE event_id = ? AND applied_at IS NULL)";
      statements.push(this.db.prepare(`UPDATE app_records SET document = json_set(document, '$.billedBytes', COALESCE(json_extract(document, '$.billedBytes'), 0) + ?, '$.updatedAt', ?), updated_at = CURRENT_TIMESTAMP
        WHERE collection = 'users' AND record_id = ? AND ${eventExists} AND COALESCE(json_extract(document, '$.planStartedAt'), '') <= ?`)
        .bind(row.billed_bytes, appliedAt, row.user_id, row.event_id, row.occurred_at));
      statements.push(this.db.prepare(`INSERT INTO app_records(collection, record_id, document, created_at, updated_at)
        SELECT 'daily-usage', ?, json_object('userId', ?, 'usageDay', ?, 'rawBytes', ?, 'billedBytes', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        WHERE ${eventExists} AND EXISTS (SELECT 1 FROM app_records WHERE collection = 'users' AND record_id = ?)
        ON CONFLICT(collection, record_id) DO UPDATE SET document = json_set(app_records.document,
          '$.rawBytes', COALESCE(json_extract(app_records.document, '$.rawBytes'), 0) + ?,
          '$.billedBytes', COALESCE(json_extract(app_records.document, '$.billedBytes'), 0) + ?), updated_at = CURRENT_TIMESTAMP`)
        .bind(`${row.user_id}:${row.usage_day}`, row.user_id, row.usage_day, row.raw_bytes, row.billed_bytes, row.event_id, row.user_id, row.raw_bytes, row.billed_bytes));
      statements.push(this.db.prepare(`UPDATE usage_events SET applied_at = ? WHERE event_id = ? AND applied_at IS NULL
        AND EXISTS (SELECT 1 FROM app_records WHERE collection = 'users' AND record_id = ?)`)
        .bind(appliedAt, row.event_id, row.user_id));
    }
    const results = await this.db.batch(statements);
    const events = pending.flatMap((row, index) => (results[index * 3 + 2]?.meta.changes ?? 0) === 1 ? [{
      id: row.event_id,
      eventId: row.event_id,
      userId: row.user_id,
      nodeId: row.node_id,
      inboundId: row.inbound_id,
      rawBytes: row.raw_bytes,
      billedBytes: row.billed_bytes,
      multiplier: row.multiplier,
      occurredAt: row.occurred_at,
      usageDay: row.usage_day,
    }] : []);
    const remaining = await this.db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE applied_at IS NULL").first<{ count: number }>();
    return { events, unapplied: remaining?.count ?? 0 };
  }
}
