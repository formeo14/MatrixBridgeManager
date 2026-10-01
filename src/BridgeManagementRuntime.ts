import { Intent, MatrixClient, PLManager } from "matrix-bot-sdk";
import { BridgeConfig } from "./config/Config";
import { BridgePermissionLevel } from "./config/BridgePermissionLevel";
import { ApiError, ErrCode } from "./api";
import { BridgeManagementService } from "./bridgeManagement/BridgeManagementService";
import {
  BridgeDatabase,
  openBridgeDatabase,
} from "./bridgeManagement/BridgeDatabase";
import {
  CommandBridgeAdapter,
  MatrixCommandClient,
} from "./bridgeManagement/CommandBridgeAdapter";
import { BotSdkCommandClient } from "./bridgeManagement/MatrixCommandClient";
import {
  BridgeManagementError,
  OperationRequest,
} from "./bridgeManagement/Types";

export class BridgeManagementRuntime {
  public readonly service: BridgeManagementService;
  private readonly databases = new Map<string, BridgeDatabase>();
  private readonly clients = new Map<string, MatrixCommandClient>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly intent: Intent,
  ) {
    const management = config.bridgeManagement;
    if (!management) throw new Error("Bridge management is not configured");
    const timeoutMs = management.timeoutMs ?? 20000;
    for (const bridge of management.bridges)
      this.databases.set(
        bridge.id,
        openBridgeDatabase(bridge.database, timeoutMs),
      );
    const botClient = new BotSdkCommandClient(
      intent.underlyingClient,
      intent.userId,
    );
    this.clients.set(intent.userId, botClient);
    for (const [userId, token] of Object.entries(management.ownerTokens))
      if (userId !== intent.userId)
        this.clients.set(
          userId,
          new BotSdkCommandClient(
            new MatrixClient(config.bridge.url, token),
            userId,
          ),
        );
    this.service = new BridgeManagementService(
      management,
      (actor, roomId) => this.authorize(actor, roomId, true),
      (account) => {
        const bridge = management.bridges.find(
          (item) => item.id === account.bridgeId,
        )!;
        return new CommandBridgeAdapter({
          bridge,
          account,
          database: this.databases.get(bridge.id)!,
          clientFor: (userId) => this.clients.get(userId),
          botClient,
          timeoutMs,
        });
      },
    );
  }

  async close(): Promise<void> {
    this.service.close();
    await Promise.all(
      [...this.databases.values()].map((database) => database.close()),
    );
  }

  async authorize(
    actor: string,
    roomId: string,
    write: boolean,
  ): Promise<void> {
    if (
      !this.config.checkPermission(
        actor,
        "bridgeManagement",
        BridgePermissionLevel.manageConnections,
      )
    )
      throw new ApiError(
        "Bridge management permission is required",
        ErrCode.ForbiddenUser,
      );
    const client = this.intent.underlyingClient;
    try {
      const [actorMember, botMember] = await Promise.all([
        client.getRoomStateEventContent(roomId, "m.room.member", actor),
        client.getRoomStateEventContent(
          roomId,
          "m.room.member",
          this.intent.userId,
        ),
      ]);
      if (actorMember.membership !== "join" || botMember.membership !== "join")
        throw new Error("Not joined");
    } catch {
      throw new ApiError(
        "The manager and Hookshot bot must be joined to the room",
        ErrCode.NotInRoom,
      );
    }
    if (!write) return;
    const power = new PLManager(
      await client.getRoomCreateEvent(roomId),
      await client.getRoomStateEventContent(roomId, "m.room.power_levels", ""),
    );
    const required = Math.max(50, power.currentPL.state_default ?? 50);
    if (power.getUserPowerLevel(actor) < required)
      throw new ApiError(
        "Room management power is required",
        ErrCode.ForbiddenUser,
      );
  }

  async rooms(actor: string): Promise<{ id: string; name: string }[]> {
    const roomIds = new Set(
      this.config.bridgeManagement?.accounts
        .filter((account) => account.managers.includes(actor))
        .flatMap((account) => account.allowedRooms) ?? [],
    );
    const rooms = await Promise.all(
      [...roomIds].map(async (id) => {
        try {
          await this.authorize(actor, id, true);
        } catch {
          return null;
        }
        const content = await this.intent.underlyingClient
          .getRoomStateEventContent(id, "m.room.name", "")
          .catch(() => null);
        const name =
          typeof content?.name === "string" && content.name.trim()
            ? content.name
            : id;
        return { id, name };
      }),
    );
    return rooms
      .filter((room): room is { id: string; name: string } => room !== null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  authorizeAccount(actor: string, accountId: string): void {
    const account = this.config.bridgeManagement?.accounts.find(
      (item) => item.id === accountId,
    );
    if (!account || !account.managers.includes(actor))
      throw new ApiError("Account access denied", ErrCode.ForbiddenUser);
  }

  authorizeAccountContext(
    actor: string,
    roomId: string,
    accountId: string,
  ): void {
    const account = this.config.bridgeManagement?.accounts.find(
      (item) => item.id === accountId,
    );
    if (
      !account ||
      !account.managers.includes(actor) ||
      !account.allowedRooms.includes(roomId)
    )
      throw new ApiError(
        "Account is not available in this room",
        ErrCode.ForbiddenUser,
      );
  }

  async call<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof BridgeManagementError) {
        const forbidden = /forbidden|unauthorized|permission/i.test(error.code);
        throw new ApiError(
          error.message,
          forbidden ? ErrCode.ForbiddenUser : ErrCode.BadValue,
          forbidden ? 403 : 400,
          { bridgeCode: error.code },
        );
      }
      throw new ApiError(
        "Bridge management request failed; check bridge availability",
        ErrCode.Unknown,
      );
    }
  }

  async execute(actor: string, contextRoom: string, body: unknown) {
    await this.authorize(actor, contextRoom, true);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ApiError("An operation object is required", ErrCode.BadValue);
    const operation = body as OperationRequest;
    this.authorizeAccount(actor, operation.accountId);
    if (
      !["connect", "move", "disconnect", "set-relay"].includes(
        operation.action,
      ) ||
      typeof operation.accountId !== "string" ||
      typeof operation.chatId !== "string"
    )
      throw new ApiError("Invalid operation", ErrCode.BadValue);
    return this.call(() => this.service.execute(actor, operation));
  }
}
