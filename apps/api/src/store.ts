import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CheckpointStatus = "pending" | "approved" | "denied" | "expired";

export type Checkpoint = {
  id: string;
  actionHash: string;
  action: unknown;
  status: CheckpointStatus;
  state: string;
  salt: string;
  codeVerifier: string;
  idToken?: string;
  detail?: string;
  createdAt: number;
};

export type FeedEvent = {
  id: number;
  type: "decision" | "outcome" | "checkpoint";
  at: number;
  data: unknown;
};

export type ApiKey = {
  id: string;
  name: string;
  hint: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

export type RequestRecord = {
  id: number;
  at: number;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  auth: "api_key" | "x402" | "none";
  keyId?: string;
  verdict?: string;
  decisionId?: string;
};

type RequestRow = {
  id: number;
  at: number;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  auth: RequestRecord["auth"];
  key_id: string | null;
  verdict: string | null;
  decision_id: string | null;
};

function rowToKey(row: Record<string, never>): ApiKey {
  const r = row as unknown as { id: string; name: string; hint: string; created_at: number; last_used_at: number | null; revoked_at: number | null };
  return {
    id: r.id,
    name: r.name,
    hint: r.hint,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
    revokedAt: r.revoked_at ?? undefined,
  };
}

function rowToRequest(r: RequestRow): RequestRecord {
  return {
    id: r.id,
    at: r.at,
    method: r.method,
    path: r.path,
    status: r.status,
    latencyMs: r.latency_ms,
    auth: r.auth,
    keyId: r.key_id ?? undefined,
    verdict: r.verdict ?? undefined,
    decisionId: r.decision_id ?? undefined,
  };
}

/** Append-only history. This never drops or clears anything, so it is safe to point at an existing file. Revoking a key only marks it. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, state TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, verdict TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, hint TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, auth TEXT NOT NULL, key_id TEXT, verdict TEXT, decision_id TEXT);
      CREATE INDEX IF NOT EXISTS requests_at ON requests (at);
    `);
  }

  addEvent(type: FeedEvent["type"], data: unknown): FeedEvent {
    const at = Date.now();
    const row = this.db
      .prepare("INSERT INTO events (type, at, data) VALUES (?, ?, ?) RETURNING id")
      .get(type, at, JSON.stringify(data)) as { id: number };
    return { id: row.id, type, at, data };
  }

  recentEvents(limit = 100): FeedEvent[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as unknown as {
      id: number;
      type: FeedEvent["type"];
      at: number;
      data: string;
    }[];
    return rows.reverse().map((r) => ({ id: r.id, type: r.type, at: r.at, data: JSON.parse(r.data) }));
  }

  saveDecision(id: string, verdict: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO decisions (id, verdict, at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(id, verdict, Date.now(), JSON.stringify(data));
  }

  decision<T>(id: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM decisions WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  verdictCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT verdict, COUNT(*) AS n FROM decisions GROUP BY verdict").all() as unknown as {
      verdict: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
  }

  recentDecisions<T>(limit = 200): T[] {
    const rows = this.db.prepare("SELECT data FROM decisions ORDER BY at DESC LIMIT ?").all(limit) as unknown as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  addKey(key: ApiKey & { hash: string }): void {
    this.db
      .prepare("INSERT INTO api_keys (id, name, hash, hint, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key.id, key.name, key.hash, key.hint, key.createdAt);
  }

  keys(): ApiKey[] {
    const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as unknown as Record<string, never>[];
    return rows.map(rowToKey);
  }

  keyByHash(hash: string): ApiKey | undefined {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE hash = ?").get(hash) as Record<string, never> | undefined;
    return row ? rowToKey(row) : undefined;
  }

  touchKey(id: string, at: number): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at, id);
  }

  revokeKey(id: string, at: number): boolean {
    return this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes > 0;
  }

  addRequest(r: Omit<RequestRecord, "id">): void {
    this.db
      .prepare("INSERT INTO requests (at, method, path, status, latency_ms, auth, key_id, verdict, decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.at, r.method, r.path, r.status, r.latencyMs, r.auth, r.keyId ?? null, r.verdict ?? null, r.decisionId ?? null);
  }

  requests(limit = 100): RequestRecord[] {
    const rows = this.db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT ?").all(limit) as unknown as RequestRow[];
    return rows.map(rowToRequest);
  }

  requestCountSince(at: number, keyId?: string): number {
    const row = (
      keyId
        ? this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE at >= ? AND key_id = ?").get(at, keyId)
        : this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE at >= ?").get(at)
    ) as { n: number };
    return row.n;
  }

  /** Counts per hour by outcome, oldest first, for the usage chart. */
  hourlyUsage(since: number): { hour: number; cleared: number; refused: number; other: number }[] {
    const rows = this.db
      .prepare(
        `SELECT (at / 3600000) * 3600000 AS hour,
           SUM(CASE WHEN verdict IN ('ALLOW','REDUCE') THEN 1 ELSE 0 END) AS cleared,
           SUM(CASE WHEN verdict = 'BLOCK' THEN 1 ELSE 0 END) AS refused,
           SUM(CASE WHEN verdict IS NULL OR verdict = 'HUMAN_REQUIRED' THEN 1 ELSE 0 END) AS other
         FROM requests WHERE at >= ? GROUP BY hour ORDER BY hour`,
      )
      .all(since) as unknown as { hour: number; cleared: number; refused: number; other: number }[];
    return rows;
  }

  saveCheckpoint(checkpoint: Checkpoint): void {
    this.db
      .prepare("INSERT INTO checkpoints (id, state, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(checkpoint.id, checkpoint.state, JSON.stringify(checkpoint));
  }

  /** The newest checkpoint for this exact action that the owner hasn't answered. */
  pendingCheckpointFor(actionHash: string): Checkpoint | undefined {
    const rows = this.db
      .prepare("SELECT data FROM checkpoints WHERE json_extract(data, '$.actionHash') = ? AND json_extract(data, '$.status') = 'pending' ORDER BY rowid DESC LIMIT 1")
      .all(actionHash) as unknown as { data: string }[];
    return rows[0] ? (JSON.parse(rows[0].data) as Checkpoint) : undefined;
  }

  checkpoint(id: string): Checkpoint | undefined {
    const row = this.db.prepare("SELECT data FROM checkpoints WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  checkpointByState(state: string): Checkpoint | undefined {
    const row = this.db.prepare("SELECT data FROM checkpoints WHERE state = ?").get(state) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
}
