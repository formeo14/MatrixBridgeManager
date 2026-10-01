import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SqliteBridgeDatabase } from "../../src/bridgeManagement/BridgeDatabase";
import { CommandBridgeAdapter } from "../../src/bridgeManagement/CommandBridgeAdapter";
import type { BridgeOperation } from "../../src/bridgeManagement/Types";
import {
  BRIDGE,
  LOGIN,
  OWNER,
  createSqliteBridgeDatabase,
} from "./fixtures/bridgeFixture";
import {
  BRIDGE_BOT,
  BridgeSimulator,
  PREFIX,
} from "./fixtures/bridgeSimulator";

const SHARED = "!shared:bridge.test";
const TARGET = "!target:bridge.test";
const PORTAL_ROOM = "!portal-volunteers:bridge.test";
const VOLUNTEERS = "120363001@g.us";
const TRAINING = "120363002@g.us";
const LOGISTICS = "120363003@g.us";

let directory: string;
let writer: DatabaseSync;
let reader: SqliteBridgeDatabase;
let bridge: BridgeSimulator;
let adapter: CommandBridgeAdapter;
let sequence = 0;

function operation(
  input: Partial<BridgeOperation> & Pick<BridgeOperation, "action" | "chat_id">,
): BridgeOperation {
  return {
    id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    owner: OWNER,
    login_id: LOGIN,
    ...input,
  };
}

function build(timeoutMs = 400) {
  adapter = new CommandBridgeAdapter({
    bridge: {
      id: "whatsapp",
      network: "whatsapp",
      botUserId: BRIDGE_BOT,
      commandPrefix: PREFIX,
      database: { type: "sqlite", path: "" },
    },
    account: {
      id: "wa",
      bridgeId: "whatsapp",
      owner: OWNER,
      loginId: LOGIN,
      managers: [OWNER],
      allowedRooms: [SHARED, TARGET],
    },
    database: reader,
    clientFor: (userId) =>
      userId === OWNER ? bridge.client(OWNER) : undefined,
    timeoutMs,
    pollIntervalMs: 10,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bridge-merge-adapter-"));
  const path = join(directory, "whatsapp.db");
  writer = createSqliteBridgeDatabase(path);
  reader = new SqliteBridgeDatabase(path);
  bridge = new BridgeSimulator(writer);
  for (const room of [SHARED, TARGET, PORTAL_ROOM]) bridge.join(room, OWNER);
  for (const room of [SHARED, PORTAL_ROOM]) bridge.join(room, BRIDGE_BOT);
  build();
});

afterEach(async () => {
  await reader.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("reading bridge state", () => {
  it("lists the owner's login with all capabilities", async () => {
    expect(await adapter.accounts()).toContainEqual({
      owner: OWNER,
      login_id: LOGIN,
      name: "Shared WhatsApp",
      capabilities: ["connect", "move", "disconnect", "set-relay"],
    });
  });

  it("lists only this login's groups, never DMs or other logins' groups", async () => {
    expect((await adapter.chats()).map((chat) => chat.name)).toEqual([
      "Britstadt Volunteers",
      "Equipment & Logistics",
      "Training & Exercises",
    ]);
  });

  it("reports existing mappings with their relay", async () => {
    expect(await adapter.portals()).toEqual([
      { chat_id: VOLUNTEERS, room_id: PORTAL_ROOM, relay: false },
      {
        chat_id: LOGISTICS,
        room_id: SHARED,
        relay: true,
        relay_owner: OWNER,
        relay_login_id: LOGIN,
      },
    ]);
  });

  it("reports no capabilities when no token is configured for the owner", async () => {
    adapter = new CommandBridgeAdapter({
      bridge: {
        id: "whatsapp",
        network: "whatsapp",
        botUserId: BRIDGE_BOT,
        commandPrefix: PREFIX,
        database: { type: "sqlite", path: "" },
      },
      account: {
        id: "wa",
        bridgeId: "whatsapp",
        owner: OWNER,
        loginId: LOGIN,
        managers: [OWNER],
        allowedRooms: [TARGET],
      },
      database: reader,
      clientFor: () => undefined,
      timeoutMs: 100,
    });
    expect(
      (await adapter.accounts()).find((login) => login.login_id === LOGIN)
        ?.capabilities,
    ).toEqual([]);
  });
});

describe("changing bridge state through bridge commands", () => {
  it("connects by inviting the bridge bot and sending the bridge command", async () => {
    const result = await adapter.execute(
      operation({ action: "connect", chat_id: TRAINING, room_id: TARGET }),
    );
    expect(result).toMatchObject({
      status: "completed",
      portal: { chat_id: TRAINING, room_id: TARGET },
    });
    expect(bridge.membership.get(`${TARGET}|${BRIDGE_BOT}`)).toBe("join");
    expect(bridge.sent.map((event) => event.body)).toEqual([
      `${PREFIX} bridge ${LOGIN} ${TRAINING}`,
    ]);
  });

  it("refuses a room that already holds a group of the same bridge", async () => {
    const result = await adapter.execute(
      operation({ action: "connect", chat_id: TRAINING, room_id: SHARED }),
    );
    expect(result.status).toBe("rejected");
    expect(result.error).toContain("one group per bridge");
    expect(bridge.sent).toEqual([]);
  });

  it("moves with unbridge then bridge and never uses --overwrite", async () => {
    const result = await adapter.execute(
      operation({
        action: "move",
        chat_id: VOLUNTEERS,
        expected_room_id: PORTAL_ROOM,
        room_id: TARGET,
      }),
    );
    expect(result).toMatchObject({
      status: "completed",
      portal: { room_id: TARGET },
    });
    expect(bridge.sent.map((event) => [event.roomId, event.body])).toEqual([
      [PORTAL_ROOM, `${PREFIX} unbridge`],
      [TARGET, `${PREFIX} bridge ${LOGIN} ${VOLUNTEERS}`],
    ]);
    expect(bridge.overwriteUsed).toBe(false);
  });

  it("disconnects without touching other rows", async () => {
    const before = writer
      .prepare(
        "SELECT id, mxid, relay_login_id FROM portal WHERE id != ? ORDER BY id",
      )
      .all(LOGISTICS);
    const result = await adapter.execute(
      operation({
        action: "disconnect",
        chat_id: LOGISTICS,
        expected_room_id: SHARED,
      }),
    );
    expect(result).toMatchObject({ status: "completed", portal: null });
    expect(
      writer
        .prepare(
          "SELECT id, mxid, relay_login_id FROM portal WHERE id != ? ORDER BY id",
        )
        .all(LOGISTICS),
    ).toEqual(before);
  });

  it("refuses to disconnect on a homeserver that deletes rooms on cleanup", async () => {
    bridge.deletesRooms = true;
    const result = await adapter.execute(
      operation({
        action: "disconnect",
        chat_id: LOGISTICS,
        expected_room_id: SHARED,
      }),
    );
    expect(result.status).toBe("rejected");
    expect(bridge.sent).toEqual([]);
  });

  it("enables and disables relay", async () => {
    expect(
      await adapter.execute(
        operation({
          action: "set-relay",
          chat_id: VOLUNTEERS,
          expected_room_id: PORTAL_ROOM,
          relay: true,
          relay_owner: OWNER,
          relay_login_id: LOGIN,
        }),
      ),
    ).toMatchObject({
      status: "completed",
      portal: { relay: true, relay_login_id: LOGIN },
    });
    expect(
      await adapter.execute(
        operation({
          action: "set-relay",
          chat_id: VOLUNTEERS,
          expected_room_id: PORTAL_ROOM,
          relay: false,
        }),
      ),
    ).toMatchObject({ status: "completed", portal: { relay: false } });
  });

  it("reports the bridge's own refusal", async () => {
    bridge.relayEnabled = false;
    const result = await adapter.execute(
      operation({
        action: "set-relay",
        chat_id: VOLUNTEERS,
        expected_room_id: PORTAL_ROOM,
        relay: true,
        relay_owner: OWNER,
        relay_login_id: LOGIN,
      }),
    );
    expect(result).toMatchObject({
      status: "rejected",
      error: "This bridge does not allow relay mode",
    });
  });

  it("stays pending when the bridge does not answer, and reconciles later", async () => {
    bridge.silent = true;
    const op = operation({
      action: "connect",
      chat_id: TRAINING,
      room_id: TARGET,
    });
    expect((await adapter.execute(op)).status).toBe("pending");
    expect((await adapter.reconcile(op)).status).toBe("rejected");
    writer
      .prepare("UPDATE portal SET mxid = ? WHERE bridge_id = ? AND id = ?")
      .run(TARGET, BRIDGE, TRAINING);
    expect((await adapter.reconcile(op)).status).toBe("completed");
  });

  it("rejects chat IDs that could inject extra command arguments", async () => {
    const result = await adapter.execute(
      operation({
        action: "connect",
        chat_id: "x --overwrite",
        room_id: TARGET,
      }),
    );
    expect(result.status).toBe("rejected");
    expect(bridge.sent).toEqual([]);
  });

  it("asks for an invitation when the owner is not in the room", async () => {
    bridge.membership.delete(`${TARGET}|${OWNER}`);
    const result = await adapter.execute(
      operation({ action: "connect", chat_id: TRAINING, room_id: TARGET }),
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.error).toContain("must be invited");
  });
});
