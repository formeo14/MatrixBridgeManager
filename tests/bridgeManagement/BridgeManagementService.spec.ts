import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeManagementService } from "../../src/bridgeManagement/BridgeManagementService";
import type {
  BridgeManagementAdapter,
  BridgeManagementConfig,
  BridgeOperation,
  OperationResult,
  RemotePortal,
} from "../../src/bridgeManagement/Types";

class Adapter implements BridgeManagementAdapter {
  public portalsState: RemotePortal[] = [];
  public operations = new Map<string, OperationResult>();
  public uncertain = false;
  public rejected = false;
  public loggedIn = true;
  public mutations = 0;
  public async accounts() {
    return this.loggedIn
      ? [
          {
            owner: "@owner:test",
            login_id: "login",
            name: "Real login",
            capabilities: [
              "connect",
              "move",
              "disconnect",
              "set-relay",
            ] as BridgeOperation["action"][],
          },
        ]
      : [];
  }
  public async chats() {
    return [{ id: "chat", name: "Team" }];
  }
  public async portals() {
    return structuredClone(this.portalsState);
  }
  public async execute(operation: BridgeOperation): Promise<OperationResult> {
    this.mutations++;
    if (this.rejected)
      return {
        version: 1,
        id: operation.id,
        status: "rejected",
        portal: null,
        error: "Rejected",
      };
    const portal =
      operation.action === "disconnect"
        ? null
        : {
            chat_id: operation.chat_id,
            room_id: operation.room_id ?? operation.expected_room_id!,
            relay: operation.relay ?? false,
            relay_owner: operation.relay_owner,
            relay_login_id: operation.relay_login_id,
          };
    this.portalsState = portal ? [portal] : [];
    const result: OperationResult = {
      version: 1,
      id: operation.id,
      status: "completed",
      portal,
    };
    this.operations.set(operation.id, result);
    if (this.uncertain) throw new Error("Lost response");
    return result;
  }
  public async reconcile(operation: BridgeOperation): Promise<OperationResult> {
    const result = this.operations.get(operation.id);
    if (!result) throw new Error("Unknown operation");
    return result;
  }
}
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.reverse()) await task();
  cleanup.length = 0;
});
async function fixture(
  authorizer: (actor: string, room: string) => Promise<void> = async () =>
    undefined,
) {
  const directory = await mkdtemp(join(tmpdir(), "management-service-"));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const config: BridgeManagementConfig = {
    statePath: join(directory, "operations.sqlite"),
    bridges: [],
    ownerTokens: {},
    accounts: [
      {
        id: "line",
        bridgeId: "line",
        owner: "@owner:test",
        loginId: "login",
        managers: ["@manager:test"],
        allowedRooms: ["!one:test", "!two:test"],
      },
    ],
  };
  const adapter = new Adapter();
  const service = new BridgeManagementService(
    config,
    authorizer,
    () => adapter,
  );
  cleanup.push(() => service.close());
  await service.initialize();
  return { service, adapter, config };
}
const connect = {
  accountId: "line",
  action: "connect" as const,
  chatId: "chat",
  roomId: "!one:test",
};
describe("BridgeManagementService", () => {
  it("rejects unauthorized actor and destination before remote mutation", async () => {
    const { service, adapter } = await fixture();
    await expect(
      service.execute("@intruder:test", connect),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.execute("@manager:test", {
        ...connect,
        roomId: "!forbidden:test",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(adapter.mutations).toBe(0);
  });
  it("checks live Matrix permissions inside serialized operations", async () => {
    let allowed = true;
    const { service, adapter } = await fixture(async () => {
      if (!allowed) throw new Error("Power revoked");
    });
    await service.execute("@manager:test", connect);
    allowed = false;
    await expect(
      service.execute("@manager:test", {
        ...connect,
        action: "move",
        expectedRoomId: "!one:test",
        roomId: "!two:test",
      }),
    ).rejects.toThrow("Power revoked");
    expect(adapter.portalsState[0].room_id).toBe("!one:test");
  });
  it("prevents concurrent duplicate mappings using authoritative remote state", async () => {
    const { service, adapter } = await fixture();
    const results = await Promise.allSettled([
      service.execute("@manager:test", connect),
      service.execute("@manager:test", connect),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(adapter.mutations).toBe(1);
  });
  it("persists uncertain operation in SQLite and reconciles after restart", async () => {
    const { service, adapter, config } = await fixture();
    adapter.uncertain = true;
    await expect(
      service.execute("@manager:test", connect),
    ).rejects.toMatchObject({ code: "RECONCILE_REQUIRED" });
    const restarted = new BridgeManagementService(
      config,
      async () => undefined,
      () => adapter,
    );
    cleanup.push(() => restarted.close());
    await restarted.initialize();
    await expect(
      restarted.execute("@manager:test", connect),
    ).rejects.toMatchObject({ code: "RECONCILE_REQUIRED" });
    expect((await restarted.reconcile("@manager:test", "line"))?.status).toBe(
      "completed",
    );
    expect(
      (await restarted.accounts("@manager:test"))[0].pendingOperationId,
    ).toBeUndefined();
  });
  it("keeps rejected moves on original portal and clears pending state", async () => {
    const { service, adapter } = await fixture();
    await service.execute("@manager:test", connect);
    adapter.rejected = true;
    expect(
      (
        await service.execute("@manager:test", {
          ...connect,
          action: "move",
          expectedRoomId: "!one:test",
          roomId: "!two:test",
        })
      ).status,
    ).toBe("rejected");
    expect(adapter.portalsState[0].room_id).toBe("!one:test");
    expect(
      (await service.accounts("@manager:test"))[0].pendingOperationId,
    ).toBeUndefined();
  });
  it("requires approved relay identity and resolves owner and login server-side", async () => {
    const { service, adapter } = await fixture();
    await service.execute("@manager:test", connect);
    const request = {
      accountId: "line",
      action: "set-relay" as const,
      chatId: "chat",
      expectedRoomId: "!one:test",
      relay: true,
    };
    await expect(
      service.execute("@manager:test", request),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.execute("@manager:test", {
        ...request,
        relayAccountId: "unapproved",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.execute("@manager:test", {
      ...request,
      relayAccountId: "line",
    });
    expect(adapter.portalsState[0]).toMatchObject({
      relay: true,
      relay_owner: "@owner:test",
      relay_login_id: "login",
    });
  });
  it("reports login required without fabricating chats or leaking secrets", async () => {
    const { service, adapter } = await fixture();
    adapter.loggedIn = false;
    const result = await service.accounts("@manager:test");
    expect(result[0].status).toBe("login-required");
    expect(JSON.stringify(result)).not.toContain("secret");
    await expect(service.chats("@manager:test", "line")).rejects.toMatchObject({
      code: "LOGIN_REQUIRED",
    });
  });
});

it("rejects configured aliases for the same normalized remote login", async () => {
  const { config, adapter } = await fixture();
  const duplicate = structuredClone(config);
  duplicate.accounts.push({
    ...duplicate.accounts[0],
    id: "alias",
  });
  expect(
    () =>
      new BridgeManagementService(
        duplicate,
        async () => undefined,
        () => adapter,
      ),
  ).toThrow("Duplicate bridge login configuration");
});
it("fails closed when persisted operations have corrupted fields or missing action parameters", async () => {
  const { service, config, adapter } = await fixture();
  adapter.uncertain = true;
  await expect(service.execute("@manager:test", connect)).rejects.toMatchObject(
    { code: "RECONCILE_REQUIRED" },
  );
  const database = new DatabaseSync(config.statePath);
  const row = database
    .prepare(
      "SELECT operation FROM bridge_management_operations WHERE status='pending'",
    )
    .get();
  if (!row || typeof row.operation !== "string")
    throw new Error("Missing operation");
  const original = JSON.parse(row.operation) as Record<string, unknown>;
  for (const corrupted of [
    { ...original, owner: 42 },
    { ...original, action: "destroy" },
    { ...original, chat_id: null },
    { ...original, room_id: undefined },
    { ...original, relay_owner: "@untrusted:test" },
  ]) {
    database
      .prepare(
        "UPDATE bridge_management_operations SET operation=? WHERE status='pending'",
      )
      .run(JSON.stringify(corrupted));
    const restarted = new BridgeManagementService(
      config,
      async () => undefined,
      () => adapter,
    );
    try {
      await expect(restarted.initialize()).rejects.toMatchObject({
        code: "INVALID_STATE",
      });
    } finally {
      restarted.close();
    }
  }
  database.close();
});
