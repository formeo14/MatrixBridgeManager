import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import {
  PostgresBridgeDatabase,
  SqliteBridgeDatabase,
} from "../../src/bridgeManagement/BridgeDatabase";
import { LOGIN, seedStatements, sqliteParams } from "./fixtures/bridgeFixture";

const sqlitePath = process.env.BRIDGE_MERGE_REAL_SQLITE;
const postgresUri = process.env.BRIDGE_MERGE_REAL_POSTGRES;
const bridgeId = process.env.BRIDGE_MERGE_REAL_BRIDGE_ID ?? "whatsapp";

const WRITES = [
  "UPDATE portal SET mxid = NULL",
  "DELETE FROM user_login",
  "DROP TABLE portal",
];

function seed() {
  return seedStatements().map(([sql, params]) => [
    sql.replace(/'whatsapp'|\$1\b/g, (match) =>
      match === "$1" ? "$1" : `'${bridgeId}'`,
    ),
    params.map((value) => (value === "whatsapp" ? bridgeId : value)),
  ]) as Array<[string, unknown[]]>;
}

class ProbeSqlite extends SqliteBridgeDatabase {
  public raw(sql: string) {
    return this.select(sql, []);
  }
}
class ProbePostgres extends PostgresBridgeDatabase {
  public raw(sql: string) {
    return this.select(sql, []);
  }
}

describe.skipIf(!sqlitePath)(
  "database created by a real mautrix bridge (SQLite)",
  () => {
    it("is readable, and every write is refused", async () => {
      const writer = new DatabaseSync(sqlitePath!);
      for (const [sql, params] of seed())
        writer
          .prepare(
            sql
              .replace(/\$(\d+)/g, "?$1")
              .replace(/\btrue\b/g, "1")
              .replace(/\bfalse\b/g, "0"),
          )
          .run(...(sqliteParams(params) as never[]));
      const dump = () =>
        JSON.stringify(
          ["portal", "user_login", "user_portal"].map((table) =>
            writer.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all(),
          ),
        );
      const before = dump();
      const database = new ProbeSqlite(sqlitePath!);
      expect(await database.bridgeIds()).toContain(bridgeId);
      expect(
        (await database.portals(bridgeId, LOGIN)).map((portal) => portal.name),
      ).toHaveLength(3);
      for (const sql of WRITES)
        await expect(database.raw(sql)).rejects.toThrow(/readonly/i);
      await database.close();
      expect(dump()).toBe(before);
      writer.close();
    });
  },
);

describe.skipIf(!postgresUri)(
  "database created by a real mautrix bridge (PostgreSQL)",
  () => {
    it("is readable, and every write is refused", async () => {
      const writer = new Client({ connectionString: postgresUri });
      await writer.connect();
      for (const [sql, params] of seed()) await writer.query(sql, params);
      const dump = async () =>
        JSON.stringify(
          await Promise.all(
            ["portal", "user_login", "user_portal"].map(
              async (table) =>
                (await writer.query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`))
                  .rows,
            ),
          ),
        );
      const before = await dump();
      const database = new ProbePostgres(
        { type: "postgres", uri: postgresUri },
        5000,
      );
      expect(await database.bridgeIds()).toContain(bridgeId);
      expect(await database.portals(bridgeId, LOGIN)).toHaveLength(3);
      for (const sql of WRITES)
        await expect(database.raw(sql)).rejects.toThrow(
          /read-only transaction/,
        );
      await database.close();
      expect(await dump()).toBe(before);
      await writer.end();
    });
  },
);
