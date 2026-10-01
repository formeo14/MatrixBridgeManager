import Ajv from "ajv";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { BridgeManagementError } from "./Types";
import type { JournalEntry, OperationResult } from "./Types";

const operationValidator = new Ajv({ strict: true }).compile<
  JournalEntry["operation"]
>({
  type: "object",
  additionalProperties: false,
  required: ["id", "action", "owner", "login_id", "chat_id"],
  properties: {
    id: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
    action: { enum: ["connect", "move", "disconnect", "set-relay"] },
    owner: { type: "string", minLength: 1 },
    login_id: { type: "string", minLength: 1 },
    chat_id: { type: "string", minLength: 1 },
    expected_room_id: { type: "string", minLength: 1 },
    room_id: { type: "string", minLength: 1 },
    relay: { type: "boolean" },
    relay_owner: { type: "string", minLength: 1 },
    relay_login_id: { type: "string", minLength: 1 },
  },
});
export class OperationJournal {
  private readonly database: DatabaseSync;
  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS bridge_management_operations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','completed','rejected')), result TEXT, resolved_at TEXT); CREATE UNIQUE INDEX IF NOT EXISTS bridge_management_pending_account ON bridge_management_operations(account_id) WHERE status='pending';",
    );
  }
  public async load(): Promise<JournalEntry[]> {
    return this.database
      .prepare(
        "SELECT id, account_id, actor, operation, created_at FROM bridge_management_operations WHERE status='pending'",
      )
      .all()
      .map((row) => {
        if (
          typeof row.operation !== "string" ||
          typeof row.account_id !== "string" ||
          typeof row.actor !== "string" ||
          typeof row.created_at !== "string"
        )
          throw new BridgeManagementError(
            "INVALID_STATE",
            "Invalid persisted operation",
          );
        let operation: unknown;
        try {
          operation = JSON.parse(row.operation);
        } catch {
          throw new BridgeManagementError(
            "INVALID_STATE",
            "Invalid persisted operation JSON",
          );
        }
        if (!operationValidator(operation) || operation.id !== row.id)
          throw new BridgeManagementError(
            "INVALID_STATE",
            "Invalid persisted operation identity",
          );
        const needsExisting = operation.action !== "connect";
        const needsDestination =
          operation.action === "connect" || operation.action === "move";
        const isRelay = operation.action === "set-relay";
        if (
          needsExisting !== (operation.expected_room_id !== undefined) ||
          needsDestination !== (operation.room_id !== undefined) ||
          isRelay !== (operation.relay !== undefined) ||
          (operation.relay === true) !==
            (operation.relay_owner !== undefined &&
              operation.relay_login_id !== undefined) ||
          (operation.relay !== true &&
            (operation.relay_owner !== undefined ||
              operation.relay_login_id !== undefined))
        )
          throw new BridgeManagementError(
            "INVALID_STATE",
            "Invalid persisted operation parameters",
          );
        return {
          accountId: row.account_id,
          actor: row.actor,
          createdAt: row.created_at,
          operation,
        };
      });
  }
  public async begin(entry: JournalEntry): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO bridge_management_operations (id,account_id,actor,operation,created_at,status) VALUES (?,?,?,?,?,'pending')",
      )
      .run(
        entry.operation.id,
        entry.accountId,
        entry.actor,
        JSON.stringify(entry.operation),
        entry.createdAt,
      );
  }
  public async complete(id: string, result: OperationResult): Promise<void> {
    if (result.status === "pending")
      throw new BridgeManagementError(
        "INVALID_STATE",
        "Cannot resolve a pending operation",
      );
    const update = this.database
      .prepare(
        "UPDATE bridge_management_operations SET status=?, result=?, resolved_at=? WHERE id=? AND status='pending'",
      )
      .run(result.status, JSON.stringify(result), new Date().toISOString(), id);
    if (update.changes !== 1)
      throw new BridgeManagementError(
        "INVALID_STATE",
        "Pending operation was not found",
      );
  }
  public close(): void {
    this.database.close();
  }
}
