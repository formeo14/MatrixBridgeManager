import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Intent } from "matrix-bot-sdk";
import type { BridgeConfig } from "../../src/config/Config";
import { BridgeManagementRuntime } from "../../src/BridgeManagementRuntime";
import { LOGIN, createSqliteBridgeDatabase } from "./fixtures/bridgeFixture";
import {
  BRIDGE_BOT,
  BridgeSimulator,
  PREFIX,
} from "./fixtures/bridgeSimulator";

const actor = "@manager:bridge.test";
const bot = "@linker:bridge.test";
const TRAINING = "120363002@g.us";
const runtimes: BridgeManagementRuntime[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(includeContext = true) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-merge-runtime-"));
  const writer: DatabaseSync = createSqliteBridgeDatabase(
    join(directory, "whatsapp.db"),
  );
  writer
    .prepare(`INSERT INTO "user" (bridge_id, mxid) VALUES ('whatsapp', ?)`)
    .run(bot);
  writer
    .prepare("UPDATE user_login SET user_mxid = ? WHERE id = ?")
    .run(bot, LOGIN);
  cleanups.push(() => {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const bridge = new BridgeSimulator(writer);
  const linker = bridge.client(bot);
  for (const room of ["!context", "!target", "!low", "!unnamed"])
    bridge.join(room, bot);
  const config = {
    checkPermission: () => true,
    bridge: { url: "http://127.0.0.1:1" },
    bridgeManagement: {
      statePath: join(directory, "operations.sqlite"),
      timeoutMs: 1000,
      ownerTokens: {},
      bridges: [
        {
          id: "whatsapp",
          network: "whatsapp",
          botUserId: BRIDGE_BOT,
          commandPrefix: PREFIX,
          database: { type: "sqlite", path: join(directory, "whatsapp.db") },
        },
      ],
      accounts: [
        {
          id: "wa",
          bridgeId: "whatsapp",
          network: "whatsapp",
          label: "Shared WhatsApp",
          owner: bot,
          loginId: LOGIN,
          managers: [actor],
          allowedRooms: [
            ...(includeContext ? ["!context"] : []),
            "!target",
            "!low",
            "!missing",
            "!unnamed",
          ],
        },
      ],
    },
  } as unknown as BridgeConfig;
  const intent = {
    userId: bot,
    underlyingClient: {
      async getRoomCreateEvent() {
        return { sender: bot, content: { creator: bot, room_version: "10" } };
      },
      async getRoomStateEventContent(room: string, type: string, key: string) {
        if (type === "m.room.member") {
          if (key === actor)
            return { membership: room === "!missing" ? "leave" : "join" };
          const membership = await linker.membership(room, key);
          if (!membership) throw new Error("M_NOT_FOUND");
          return { membership };
        }
        if (type === "m.room.power_levels")
          return {
            users: { [actor]: room === "!low" ? 0 : 100 },
            state_default: 50,
          };
        if (type === "m.room.name" && room !== "!unnamed")
          return { name: room === "!target" ? "Destination" : "Context" };
        throw new Error("M_NOT_FOUND");
      },
      joinRoom: (room: string) => linker.join(room),
      inviteUser: (user: string, room: string) => linker.invite(room, user),
      sendMessage: (room: string, content: { body: string }) =>
        linker.sendText(room, content.body),
      async doRequest(_method: string, path: string) {
        if (path.endsWith("/versions")) return { unstable_features: {} };
        const eventId = decodeURIComponent(path.split("/").at(-1)!);
        return {
          events_after: (bridge.replies.get(eventId) ?? []).map((body) => ({
            type: "m.room.message",
            sender: BRIDGE_BOT,
            content: { body },
          })),
        };
      },
    },
  } as unknown as Intent;
  const runtime = new BridgeManagementRuntime(config, intent);
  runtimes.push(runtime);
  await runtime.service.initialize();
  return { runtime, bridge };
}

test("lists only allowed joined rooms with management power and uses the ID for unnamed rooms", async () => {
  const { runtime } = await setup();
  const rooms = await runtime.rooms(actor);
  expect(rooms).toEqual([
    { id: "!unnamed", name: "!unnamed" },
    { id: "!context", name: "Context" },
    { id: "!target", name: "Destination" },
  ]);
  expect(await runtime.rooms("@other:bridge.test")).toEqual([]);
});

test("reads accounts and groups from the bridge database", async () => {
  const { runtime } = await setup();
  const [account] = await runtime.service.accounts(actor);
  expect(account).toMatchObject({
    id: "wa",
    status: "available",
    name: "Shared WhatsApp",
  });
  expect((await runtime.service.chats(actor, "wa")).length).toBe(3);
});

test("connects a destination different from the widget room through the bridge's own command", async () => {
  const { runtime, bridge } = await setup(false);
  const result = await runtime.execute(actor, "!context", {
    accountId: "wa",
    action: "connect",
    chatId: TRAINING,
    roomId: "!target",
  });
  expect(result).toMatchObject({
    status: "completed",
    portal: { room_id: "!target" },
  });
  expect(
    bridge.sent.map((event) => [event.sender, event.roomId, event.body]),
  ).toEqual([[bot, "!target", `${PREFIX} bridge ${LOGIN} ${TRAINING}`]]);
});

test.each(["!outside", "!low", "!missing"])(
  "rejects unauthorized destination %s before sending any bridge command",
  async (roomId) => {
    const { runtime, bridge } = await setup();
    await expect(
      runtime.execute(actor, "!context", {
        accountId: "wa",
        action: "connect",
        chatId: TRAINING,
        roomId,
      }),
    ).rejects.toThrow();
    expect(bridge.sent).toEqual([]);
  },
);
