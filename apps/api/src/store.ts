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

/** Append-only history. This never drops or clears anything, so it is safe to point at an existing file. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, state TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
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

  saveCheckpoint(checkpoint: Checkpoint): void {
    this.db
      .prepare("INSERT INTO checkpoints (id, state, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(checkpoint.id, checkpoint.state, JSON.stringify(checkpoint));
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
