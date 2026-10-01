import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { BridgeManagementError } from "./Types";
import type { BridgeDatabaseConfig } from "./Types";

export interface BridgeLoginRow {
  id: string;
  owner: string;
  name: string;
}

export interface BridgePortalRow {
  id: string;
  receiver: string;
  roomId: string | null;
  name: string;
  relayLoginId: string | null;
  relayOwner: string | null;
}

type Row = Record<string, unknown>;

export interface BridgeDatabase {
  bridgeIds(): Promise<string[]>;
  logins(bridgeId: string): Promise<BridgeLoginRow[]>;
  portals(bridgeId: string, loginId: string): Promise<BridgePortalRow[]>;
  portalInRoom(
    bridgeId: string,
    roomId: string,
  ): Promise<BridgePortalRow | null>;
  close(): Promise<void>;
}

const PORTAL_COLUMNS = `p.id AS id, p.receiver AS receiver, p.mxid AS room_id, p.name AS name,
  p.relay_login_id AS relay_login_id, rl.user_mxid AS relay_owner`;
const PORTAL_FROM = `portal p LEFT JOIN user_login rl
  ON rl.bridge_id = p.relay_bridge_id AND rl.id = p.relay_login_id`;

export const QUERIES = {
  bridgeIds: `SELECT bridge_id FROM user_login UNION SELECT bridge_id FROM portal`,
  logins: `SELECT id, user_mxid, remote_name FROM user_login WHERE bridge_id = $1 ORDER BY id`,
  portals: `SELECT ${PORTAL_COLUMNS} FROM ${PORTAL_FROM}
    WHERE p.bridge_id = $1 AND p.room_type IN ('', 'group_dm')
      AND (p.receiver = $2 OR (p.receiver = '' AND EXISTS (
        SELECT 1 FROM user_portal up WHERE up.bridge_id = p.bridge_id
          AND up.portal_id = p.id AND up.portal_receiver = p.receiver AND up.login_id = $3)))
    ORDER BY p.name, p.id`,
  portalInRoom: `SELECT ${PORTAL_COLUMNS} FROM ${PORTAL_FROM}
    WHERE p.bridge_id = $1 AND p.mxid = $2`,
} as const;

const SCHEMA_PROBE = `SELECT p.bridge_id, p.id, p.receiver, p.mxid, p.name, p.room_type,
  p.relay_bridge_id, p.relay_login_id, l.id, l.user_mxid, l.remote_name,
  up.bridge_id, up.portal_id, up.portal_receiver, up.login_id
  FROM portal p, user_login l, user_portal up WHERE 1 = 0`;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function portalRow(row: Row): BridgePortalRow {
  const id = text(row.id);
  return {
    id,
    receiver: text(row.receiver),
    roomId: nullableText(row.room_id),
    name: text(row.name).trim() || id,
    relayLoginId: nullableText(row.relay_login_id),
    relayOwner: nullableText(row.relay_owner),
  };
}

abstract class ReadOnlyBridgeDatabase implements BridgeDatabase {
  private schemaChecked?: Promise<void>;
  protected abstract select(sql: string, params: string[]): Promise<Row[]>;
  public abstract close(): Promise<void>;

  private async query(sql: string, params: string[]): Promise<Row[]> {
    this.schemaChecked ??= this.select(SCHEMA_PROBE, [])
      .then(() => undefined)
      .catch((error: unknown) => {
        this.schemaChecked = undefined;
        throw new BridgeManagementError(
          "UNAVAILABLE",
          `Bridge database is unreachable or is not a mautrix bridgev2 database: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    await this.schemaChecked;
    try {
      return await this.select(sql, params);
    } catch (error) {
      throw new BridgeManagementError(
        "UNAVAILABLE",
        `Bridge database query failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  public async bridgeIds(): Promise<string[]> {
    const rows = await this.query(QUERIES.bridgeIds, []);
    return [...new Set(rows.map((row) => text(row.bridge_id)))].filter(Boolean);
  }
  public async logins(bridgeId: string): Promise<BridgeLoginRow[]> {
    const rows = await this.query(QUERIES.logins, [bridgeId]);
    return rows.map((row) => ({
      id: text(row.id),
      owner: text(row.user_mxid),
      name: text(row.remote_name),
    }));
  }
  public async portals(
    bridgeId: string,
    loginId: string,
  ): Promise<BridgePortalRow[]> {
    const rows = await this.query(QUERIES.portals, [
      bridgeId,
      loginId,
      loginId,
    ]);
    return rows.map(portalRow);
  }
  public async portalInRoom(
    bridgeId: string,
    roomId: string,
  ): Promise<BridgePortalRow | null> {
    const rows = await this.query(QUERIES.portalInRoom, [bridgeId, roomId]);
    return rows.length ? portalRow(rows[0]) : null;
  }
}

export class SqliteBridgeDatabase extends ReadOnlyBridgeDatabase {
  private db?: DatabaseSync;
  public constructor(private readonly path: string) {
    super();
  }
  private open(): DatabaseSync {
    this.db ??= new DatabaseSync(this.path, { readOnly: true });
    return this.db;
  }
  protected async select(sql: string, params: string[]): Promise<Row[]> {
    return this.open()
      .prepare(sql.replace(/\$\d+/g, "?"))
      .all(...params) as Row[];
  }
  public async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}

export class PostgresBridgeDatabase extends ReadOnlyBridgeDatabase {
  private readonly pool: Pool;
  public constructor(
    config: Extract<BridgeDatabaseConfig, { type: "postgres" }>,
    timeoutMs: number,
  ) {
    super();
    this.pool = new Pool({
      connectionString: config.uri,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
      options: "-c default_transaction_read_only=on",
      application_name: "matrix-bridge-merge (read-only)",
    });
  }
  protected async select(sql: string, params: string[]): Promise<Row[]> {
    const client = await this.pool.connect();
    try {
      const mode = await client.query<{ transaction_read_only: string }>(
        "SHOW transaction_read_only",
      );
      if (mode.rows[0]?.transaction_read_only !== "on")
        throw new Error("PostgreSQL session is not read-only");
      return (await client.query(sql, params)).rows as Row[];
    } finally {
      client.release();
    }
  }
  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export function openBridgeDatabase(
  config: BridgeDatabaseConfig,
  timeoutMs: number,
): BridgeDatabase {
  return config.type === "sqlite"
    ? new SqliteBridgeDatabase(config.path)
    : new PostgresBridgeDatabase(config, timeoutMs);
}
