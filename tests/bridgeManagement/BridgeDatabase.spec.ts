import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  PostgresBridgeDatabase,
  QUERIES,
  SqliteBridgeDatabase,
} from "../../src/bridgeManagement/BridgeDatabase";
import {
  BRIDGE,
  LOGIN,
  bridgev2Schema,
  createSqliteBridgeDatabase,
  seedStatements,
} from "./fixtures/bridgeFixture";

const WRITES = [
  "UPDATE portal SET mxid = NULL",
  "DELETE FROM portal",
  "INSERT INTO \"user\" (bridge_id, mxid) VALUES ('x', '@x:y')",
  "DROP TABLE portal",
  "CREATE TABLE intruder (id TEXT)",
];

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

async function expectSameReads(
  database: SqliteBridgeDatabase | PostgresBridgeDatabase,
) {
  expect(await database.bridgeIds()).toEqual([BRIDGE]);
  expect((await database.logins(BRIDGE)).map((login) => login.id)).toContain(
    LOGIN,
  );
  expect(
    (await database.portals(BRIDGE, LOGIN)).map((portal) => portal.name),
  ).toEqual([
    "Britstadt Volunteers",
    "Equipment & Logistics",
    "Training & Exercises",
  ]);
  expect(
    await database.portalInRoom(BRIDGE, "!shared:bridge.test"),
  ).toMatchObject({ id: "120363003@g.us", relayLoginId: LOGIN });
}

describe("query surface", () => {
  it("only contains fixed, single SELECT statements", () => {
    for (const sql of Object.values(QUERIES)) {
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      expect(sql).not.toMatch(
        /;|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|TRUNCATE|PRAGMA|ATTACH|SET)\b/i,
      );
    }
  });
});

describe("SQLite bridge database", () => {
  let directory: string;
  let path: string;
  const digest = () =>
    ["", "-wal"].map((suffix) => {
      const contents = existsSync(path + suffix)
        ? readFileSync(path + suffix)
        : Buffer.alloc(0);
      return contents.length
        ? createHash("sha256").update(contents).digest("hex")
        : "empty";
    });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "bridge-merge-sqlite-"));
    path = join(directory, "bridge.db");
    createSqliteBridgeDatabase(path).close();
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("reads bridge state without changing a single byte of the database", async () => {
    const before = digest();
    const database = new SqliteBridgeDatabase(path);
    for (let round = 0; round < 3; round++) await expectSameReads(database);
    await database.close();
    expect(digest()).toEqual(before);
  });

  it.each(WRITES)("is refused by SQLite itself: %s", async (sql) => {
    const before = digest();
    const database = new ProbeSqlite(path);
    await expect(database.raw(sql)).rejects.toThrow(/readonly|read-only/i);
    await database.close();
    expect(digest()).toEqual(before);
  });

  it("fails clearly on a database that is not a bridgev2 database", async () => {
    const database = new SqliteBridgeDatabase(join(directory, "missing.db"));
    await expect(database.bridgeIds()).rejects.toThrow(
      /unreachable|not a mautrix/,
    );
  });
});

const adminUri = process.env.BRIDGE_MERGE_TEST_PG;

describe.skipIf(!adminUri)("PostgreSQL bridge database", () => {
  const name = `bridge_merge_test_${process.pid}`;
  let admin: Client;
  let uri: string;
  let readonlyUri: string;
  const fingerprint = async () =>
    (
      await admin.query(
        `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS sum FROM (
           SELECT row_to_json(p)::text AS t FROM portal p UNION ALL
           SELECT row_to_json(l)::text FROM user_login l UNION ALL
           SELECT row_to_json(u)::text FROM user_portal u UNION ALL
           SELECT table_name FROM information_schema.tables WHERE table_schema = 'public') x`,
      )
    ).rows[0].sum as string;

  beforeAll(async () => {
    const root = new Client({ connectionString: adminUri });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${name}`);
    await root.query(`CREATE DATABASE ${name}`);
    await root.query(`DROP ROLE IF EXISTS ${name}_ro`);
    await root.query(`CREATE ROLE ${name}_ro LOGIN PASSWORD 'readonly-test'`);
    await root.end();
    const url = new URL(adminUri!);
    url.pathname = `/${name}`;
    uri = url.toString();
    url.username = `${name}_ro`;
    url.password = "readonly-test";
    readonlyUri = url.toString();
    admin = new Client({ connectionString: uri });
    await admin.connect();
    await admin.query(bridgev2Schema("postgres"));
    for (const [sql, params] of seedStatements())
      await admin.query(sql, params);
    await admin.query(
      `GRANT SELECT ON portal, user_login, user_portal TO ${name}_ro`,
    );
  });
  afterAll(async () => {
    await admin?.end();
    const root = new Client({ connectionString: adminUri });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.query(`DROP ROLE IF EXISTS ${name}_ro`);
    await root.end();
  });

  it("reads bridge state with the bridge's own credentials without changing data", async () => {
    const before = await fingerprint();
    const database = new PostgresBridgeDatabase(
      { type: "postgres", uri },
      5000,
    );
    for (let round = 0; round < 3; round++) await expectSameReads(database);
    await database.close();
    expect(await fingerprint()).toBe(before);
  });

  it.each(WRITES)(
    "is refused by PostgreSQL even with an owner account: %s",
    async (sql) => {
      const before = await fingerprint();
      const database = new ProbePostgres({ type: "postgres", uri }, 5000);
      await expect(database.raw(sql)).rejects.toThrow(/read-only transaction/);
      await database.close();
      expect(await fingerprint()).toBe(before);
    },
  );

  it("works with a dedicated SELECT-only role", async () => {
    const database = new PostgresBridgeDatabase(
      { type: "postgres", uri: readonlyUri },
      5000,
    );
    await expectSameReads(database);
    await database.close();
  });
});
