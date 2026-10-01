import type { BridgeDatabase, BridgePortalRow } from "./BridgeDatabase";
import { BridgeManagementError } from "./Types";
import type {
  BridgeAction,
  BridgeManagementAdapter,
  BridgeOperation,
  ManagedAccountConfig,
  ManagedBridgeConfig,
  OperationResult,
  RemoteAccount,
  RemoteChat,
  RemotePortal,
} from "./Types";

export interface MatrixCommandClient {
  readonly userId: string;
  membership(roomId: string, userId: string): Promise<string | null>;
  join(roomId: string): Promise<void>;
  invite(roomId: string, userId: string): Promise<void>;
  sendText(roomId: string, body: string): Promise<string>;
  repliesAfter(
    roomId: string,
    eventId: string,
    sender: string,
  ): Promise<string[]>;
  deletesRoomsOnCleanup(): Promise<boolean>;
}

export interface CommandAdapterOptions {
  bridge: ManagedBridgeConfig;
  account: ManagedAccountConfig;
  database: BridgeDatabase;
  clientFor: (userId: string) => MatrixCommandClient | undefined;
  botClient?: MatrixCommandClient;
  timeoutMs: number;
  pollIntervalMs?: number;
}

const ALL_ACTIONS: BridgeAction[] = [
  "connect",
  "move",
  "disconnect",
  "set-relay",
];
const SAFE_ARGUMENT = /^[^\s`]{1,512}$/;

type StepOutcome =
  | { status: "done"; portal: BridgePortalRow | null }
  | { status: "rejected"; error: string }
  | { status: "pending" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CommandBridgeAdapter implements BridgeManagementAdapter {
  private resolvedBridgeId?: string;
  private readonly pollIntervalMs: number;

  public constructor(private readonly options: CommandAdapterOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  private get owner(): string {
    return this.options.account.owner;
  }

  private async bridgeId(): Promise<string> {
    if (this.resolvedBridgeId !== undefined) return this.resolvedBridgeId;
    const configured = this.options.bridge.databaseBridgeId;
    const present = await this.options.database.bridgeIds();
    if (configured) {
      if (present.length && !present.includes(configured))
        throw new BridgeManagementError(
          "INVALID_CONFIG",
          `Bridge ID ${configured} is not present in the bridge database`,
        );
      this.resolvedBridgeId = configured;
    } else if (present.length === 1) this.resolvedBridgeId = present[0];
    else
      throw new BridgeManagementError(
        present.length ? "INVALID_CONFIG" : "LOGIN_REQUIRED",
        present.length
          ? "The bridge database holds several bridges; set databaseBridgeId"
          : "The bridge has no logins yet",
      );
    return this.resolvedBridgeId;
  }

  private ownerClient(): MatrixCommandClient | undefined {
    return this.options.clientFor(this.owner);
  }

  public async accounts(): Promise<RemoteAccount[]> {
    const logins = await this.options.database.logins(await this.bridgeId());
    const canCommand = !!this.ownerClient();
    return logins.map((login) => ({
      owner: login.owner,
      login_id: login.id,
      name: login.name,
      capabilities: canCommand && login.owner === this.owner ? ALL_ACTIONS : [],
    }));
  }

  private async rows(): Promise<BridgePortalRow[]> {
    return this.options.database.portals(
      await this.bridgeId(),
      this.options.account.loginId,
    );
  }

  public async chats(): Promise<RemoteChat[]> {
    return (await this.rows()).map((row) => ({ id: row.id, name: row.name }));
  }

  public async portals(): Promise<RemotePortal[]> {
    return (await this.rows()).filter((row) => row.roomId).map(toPortal);
  }

  private async row(chatId: string): Promise<BridgePortalRow | undefined> {
    return (await this.rows()).find((row) => row.id === chatId);
  }

  private result(
    operation: BridgeOperation,
    status: OperationResult["status"],
    row: BridgePortalRow | null | undefined,
    error?: string,
  ): OperationResult {
    return {
      version: 1,
      id: operation.id,
      status,
      portal: row?.roomId ? toPortal(row) : null,
      ...(error ? { error } : {}),
    };
  }

  private reached(
    operation: BridgeOperation,
    row: BridgePortalRow | undefined,
  ) {
    switch (operation.action) {
      case "connect":
      case "move":
        return row?.roomId === operation.room_id;
      case "disconnect":
        return row?.roomId !== operation.expected_room_id;
      case "set-relay":
        return (
          row?.roomId === operation.expected_room_id &&
          (operation.relay
            ? row?.relayLoginId === operation.relay_login_id
            : !row?.relayLoginId)
        );
    }
  }

  private untouched(
    operation: BridgeOperation,
    row: BridgePortalRow | undefined,
  ) {
    return operation.action === "connect"
      ? !row?.roomId
      : row?.roomId === operation.expected_room_id &&
          (operation.action !== "set-relay" ||
            !!row?.relayLoginId !== operation.relay);
  }

  public async reconcile(operation: BridgeOperation): Promise<OperationResult> {
    const row = await this.row(operation.chat_id);
    if (this.reached(operation, row))
      return this.result(operation, "completed", row);
    if (
      operation.action === "move" &&
      row?.roomId !== operation.expected_room_id
    )
      return this.result(
        operation,
        "rejected",
        row,
        "The group was disconnected from its previous room but is not connected to the new room",
      );
    if (this.untouched(operation, row))
      return this.result(
        operation,
        "rejected",
        row,
        "The bridge did not apply this change; it is safe to retry",
      );
    return this.result(operation, "pending", row);
  }

  public async execute(operation: BridgeOperation): Promise<OperationResult> {
    const { account } = this.options;
    if (
      operation.owner !== account.owner ||
      operation.login_id !== account.loginId
    )
      throw new BridgeManagementError("FORBIDDEN", "Operation login mismatch");
    if (
      !SAFE_ARGUMENT.test(operation.chat_id) ||
      !SAFE_ARGUMENT.test(operation.login_id)
    )
      return this.result(
        operation,
        "rejected",
        null,
        "Chat or login ID cannot be used in a bridge command",
      );
    const owner = this.ownerClient();
    if (!owner)
      return this.result(
        operation,
        "rejected",
        null,
        `No access token is configured for ${this.owner}`,
      );
    const before = await this.row(operation.chat_id);
    if (!before)
      return this.result(
        operation,
        "rejected",
        null,
        "Chat is unavailable for this login",
      );

    const refuse = async (): Promise<string | undefined> => {
      if (operation.action === "connect" || operation.action === "move") {
        const occupant = await this.options.database.portalInRoom(
          await this.bridgeId(),
          operation.room_id!,
        );
        if (occupant && occupant.id !== operation.chat_id)
          return `The destination room already has a ${this.options.bridge.network} group (${occupant.name}). A room can hold one group per bridge.`;
      }
      if (
        (operation.action === "disconnect" || operation.action === "move") &&
        (await owner.deletesRoomsOnCleanup())
      )
        return "This homeserver deletes rooms when a bridge disconnects, so disconnecting could remove the shared room";
      return undefined;
    };
    const refusal = await refuse();
    if (refusal) return this.result(operation, "rejected", before, refusal);

    const prefix = this.options.bridge.commandPrefix;
    let step: StepOutcome;
    switch (operation.action) {
      case "connect":
        step = await this.command(
          owner,
          operation.room_id!,
          operation.chat_id,
          `${prefix} bridge ${operation.login_id} ${operation.chat_id}`,
          (row) => row?.roomId === operation.room_id,
        );
        break;
      case "disconnect":
        step = await this.command(
          owner,
          operation.expected_room_id!,
          operation.chat_id,
          `${prefix} unbridge`,
          (row) => row?.roomId !== operation.expected_room_id,
        );
        break;
      case "move":
        step = await this.command(
          owner,
          operation.expected_room_id!,
          operation.chat_id,
          `${prefix} unbridge`,
          (row) => row?.roomId !== operation.expected_room_id,
        );
        if (step.status === "done")
          step = await this.command(
            owner,
            operation.room_id!,
            operation.chat_id,
            `${prefix} bridge ${operation.login_id} ${operation.chat_id}`,
            (row) => row?.roomId === operation.room_id,
          );
        if (step.status === "rejected")
          step = {
            status: "rejected",
            error: `Disconnected from the previous room, but connecting failed: ${step.error}`,
          };
        break;
      case "set-relay": {
        if (operation.relay) {
          if (
            !operation.relay_owner ||
            !operation.relay_login_id ||
            !SAFE_ARGUMENT.test(operation.relay_login_id)
          )
            return this.result(
              operation,
              "rejected",
              before,
              "A relay login is required",
            );
          const relayClient = this.options.clientFor(operation.relay_owner);
          if (!relayClient)
            return this.result(
              operation,
              "rejected",
              before,
              `No access token is configured for ${operation.relay_owner}`,
            );
          step = await this.command(
            relayClient,
            operation.expected_room_id!,
            operation.chat_id,
            `${prefix} set-relay ${operation.relay_login_id}`,
            (row) => row?.relayLoginId === operation.relay_login_id,
          );
        } else
          step = await this.command(
            owner,
            operation.expected_room_id!,
            operation.chat_id,
            `${prefix} unset-relay`,
            (row) => !row?.relayLoginId,
          );
        break;
      }
    }
    const after = await this.row(operation.chat_id);
    if (step.status === "done" && this.reached(operation, after))
      return this.result(operation, "completed", after);
    if (step.status === "rejected")
      return this.result(operation, "rejected", after, step.error);
    return this.result(
      operation,
      "pending",
      after,
      "The bridge has not confirmed this change yet",
    );
  }

  private async prepareRoom(
    client: MatrixCommandClient,
    roomId: string,
  ): Promise<string | undefined> {
    if ((await client.membership(roomId, client.userId)) !== "join") {
      try {
        await client.join(roomId);
      } catch {
        try {
          await this.options.botClient?.invite(roomId, client.userId);
          await client.join(roomId);
        } catch {
          return `${client.userId} must be invited to the room before it can manage bridges there`;
        }
      }
    }
    const bot = this.options.bridge.botUserId;
    if ((await client.membership(roomId, bot)) !== "join") {
      try {
        if ((await client.membership(roomId, bot)) !== "invite")
          await client.invite(roomId, bot);
      } catch {
        return `${client.userId} cannot invite ${bot} to the room`;
      }
      const deadline = Date.now() + this.options.timeoutMs;
      while ((await client.membership(roomId, bot)) !== "join") {
        if (Date.now() > deadline) return `${bot} did not join the room`;
        await sleep(this.pollIntervalMs);
      }
    }
    return undefined;
  }

  private async command(
    client: MatrixCommandClient,
    roomId: string,
    chatId: string,
    body: string,
    done: (row: BridgePortalRow | undefined) => boolean,
  ): Promise<StepOutcome> {
    const problem = await this.prepareRoom(client, roomId);
    if (problem) return { status: "rejected", error: problem };
    const eventId = await client.sendText(roomId, body);
    const deadline = Date.now() + this.options.timeoutMs;
    let replyAt: number | undefined;
    let replies: string[] = [];
    while (Date.now() <= deadline) {
      const row = await this.row(chatId);
      if (done(row)) return { status: "done", portal: row ?? null };
      if (replyAt === undefined) {
        replies = await client
          .repliesAfter(roomId, eventId, this.options.bridge.botUserId)
          .catch(() => []);
        if (replies.length) replyAt = Date.now();
      } else if (Date.now() - replyAt > this.pollIntervalMs * 4) {
        return { status: "rejected", error: replies.join(" ").slice(0, 500) };
      }
      await sleep(this.pollIntervalMs);
    }
    return { status: "pending" };
  }
}

function toPortal(row: BridgePortalRow): RemotePortal {
  return {
    chat_id: row.id,
    room_id: row.roomId!,
    relay: !!row.relayLoginId,
    ...(row.relayOwner ? { relay_owner: row.relayOwner } : {}),
    ...(row.relayLoginId ? { relay_login_id: row.relayLoginId } : {}),
  };
}
