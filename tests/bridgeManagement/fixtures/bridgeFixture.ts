import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Dialect = "sqlite" | "postgres";

export function bridgev2Schema(dialect: Dialect): string {
  const lines = readFileSync(
    join(__dirname, "bridgev2-latest.sql"),
    "utf8",
  ).split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const directive = lines[index]
      .trim()
      .match(/^-- only: (\w+)( \(line commented\))?$/);
    if (!directive) {
      output.push(lines[index]);
      continue;
    }
    const next = lines[++index] ?? "";
    if (directive[1] !== dialect) continue;
    output.push(directive[2] ? next.replace(/^(\s*)--/, "$1") : next);
  }
  const sql = output.join("\n");
  return dialect === "sqlite" ? sql.replace(/\bjsonb\b/g, "TEXT") : sql;
}

export const BRIDGE = "whatsapp";
export const OWNER = "@relay:bridge.test";
export const OTHER_OWNER = "@someone:bridge.test";
export const LOGIN = "4915100000001";
export const OTHER_LOGIN = "4915100000002";

export interface PortalSeed {
  id: string;
  name: string;
  roomId?: string | null;
  receiver?: string;
  roomType?: string;
  relayLoginId?: string | null;
  members?: string[];
}

export const SEED_PORTALS: PortalSeed[] = [
  {
    id: "120363001@g.us",
    name: "Britstadt Volunteers",
    roomId: "!portal-volunteers:bridge.test",
  },
  { id: "120363002@g.us", name: "Training & Exercises" },
  {
    id: "120363003@g.us",
    name: "Equipment & Logistics",
    roomId: "!shared:bridge.test",
    relayLoginId: LOGIN,
  },
  { id: "4915199999999@s.whatsapp.net", name: "Direct chat", roomType: "dm" },
  {
    id: "120363004@g.us",
    name: "Someone else's group",
    members: [OTHER_LOGIN],
  },
];

export function seedStatements(
  portals: PortalSeed[] = SEED_PORTALS,
): Array<[string, unknown[]]> {
  const statements: Array<[string, unknown[]]> = [
    [
      `INSERT INTO "user" (bridge_id, mxid) VALUES ($1, $2), ($1, $3)`,
      [BRIDGE, OWNER, OTHER_OWNER],
    ],
    [
      `INSERT INTO user_login (bridge_id, user_mxid, id, remote_name, metadata) VALUES ($1, $2, $3, 'Shared WhatsApp', '{}'), ($1, $4, $5, 'Other', '{}')`,
      [BRIDGE, OWNER, LOGIN, OTHER_OWNER, OTHER_LOGIN],
    ],
  ];
  for (const portal of portals) {
    statements.push([
      `INSERT INTO portal (bridge_id, id, receiver, mxid, relay_bridge_id, relay_login_id, name, topic, avatar_id, avatar_hash, avatar_mxc, name_set, avatar_set, topic_set, in_space, room_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '', '', '', '', true, false, false, false, $8, '{}')`,
      [
        BRIDGE,
        portal.id,
        portal.receiver ?? "",
        portal.roomId ?? null,
        portal.relayLoginId ? BRIDGE : null,
        portal.relayLoginId ?? null,
        portal.name,
        portal.roomType ?? "",
      ],
    ]);
    for (const login of portal.members ?? [LOGIN])
      statements.push([
        `INSERT INTO user_portal (bridge_id, user_mxid, login_id, portal_id, portal_receiver, in_space, preferred) VALUES ($1, $2, $3, $4, $5, false, true)`,
        [
          BRIDGE,
          login === LOGIN ? OWNER : OTHER_OWNER,
          login,
          portal.id,
          portal.receiver ?? "",
        ],
      ]);
  }
  return statements;
}

export function sqliteParams(params: unknown[]): unknown[] {
  return params.map((value) =>
    typeof value === "boolean" ? Number(value) : value,
  );
}

export function createSqliteBridgeDatabase(
  path: string,
  portals?: PortalSeed[],
): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(bridgev2Schema("sqlite"));
  for (const [sql, params] of seedStatements(portals)) {
    const positional = sql
      .replace(/\$(\d+)/g, "?$1")
      .replace(/\btrue\b/g, "1")
      .replace(/\bfalse\b/g, "0");
    db.prepare(positional).run(...(sqliteParams(params) as never[]));
  }
  return db;
}
