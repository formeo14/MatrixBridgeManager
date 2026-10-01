import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { BridgeManagementError } from "./Types";
import type {
  AccountStatus,
  BridgeManagementAdapter,
  BridgeManagementConfig,
  BridgeOperation,
  JournalEntry,
  ManagedAccountConfig,
  OperationRequest,
  OperationResult,
  RemoteAccount,
  RemoteChat,
  RemotePortal,
  RoomAuthorizer,
} from "./Types";
import { OperationJournal } from "./OperationJournal";

const text = { type: "string", minLength: 1, maxLength: 4096 };
const operationResultValidator = new Ajv({
  strict: true,
}).compile<OperationResult>({
  type: "object",
  additionalProperties: false,
  required: ["version", "id", "status", "portal"],
  properties: {
    version: { const: 1 },
    id: text,
    status: { enum: ["completed", "rejected", "pending"] },
    portal: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["chat_id", "room_id", "relay"],
          properties: {
            chat_id: text,
            room_id: text,
            relay: { type: "boolean" },
            relay_owner: text,
            relay_login_id: text,
          },
        },
        { type: "null" },
      ],
    },
    error: { type: "string", maxLength: 4096 },
  },
});

const inputValidator = new Ajv({ strict: true }).compile<OperationRequest>({
  type: "object",
  additionalProperties: false,
  required: ["accountId", "action", "chatId"],
  properties: {
    accountId: { type: "string", minLength: 1, maxLength: 512 },
    action: { enum: ["connect", "move", "disconnect", "set-relay"] },
    chatId: { type: "string", minLength: 1, maxLength: 4096 },
    expectedRoomId: { type: "string", minLength: 1, maxLength: 4096 },
    roomId: { type: "string", minLength: 1, maxLength: 4096 },
    relay: { type: "boolean" },
    relayAccountId: { type: "string", minLength: 1, maxLength: 512 },
  },
});
export class BridgeManagementService {
  private readonly configured = new Map<string, ManagedAccountConfig>();
  private readonly adapters = new Map<string, BridgeManagementAdapter>();
  private readonly journal: OperationJournal;
  private pending: JournalEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private ready = false;
  public constructor(
    config: BridgeManagementConfig,
    private readonly authorizeRoom: RoomAuthorizer,
    adapterFactory: (account: ManagedAccountConfig) => BridgeManagementAdapter,
  ) {
    for (const account of config.accounts) {
      if (
        [...this.configured.values()].some(
          (existing) =>
            existing.bridgeId === account.bridgeId &&
            existing.loginId === account.loginId,
        )
      )
        throw new BridgeManagementError(
          "INVALID_CONFIG",
          "Duplicate bridge login configuration",
        );
      if (this.configured.has(account.id))
        throw new BridgeManagementError(
          "INVALID_CONFIG",
          "Duplicate management account ID",
        );
      this.configured.set(account.id, structuredClone(account));
      this.adapters.set(account.id, adapterFactory(structuredClone(account)));
    }
    this.journal = new OperationJournal(config.statePath);
  }
  public async initialize(): Promise<void> {
    if (this.ready)
      throw new BridgeManagementError("INVALID_STATE", "Already initialized");
    this.pending = await this.journal.load();
    this.ready = true;
  }
  public close(): void {
    this.journal.close();
    this.ready = false;
  }
  private account(actor: string, id: string): ManagedAccountConfig {
    if (!this.ready)
      throw new BridgeManagementError(
        "INVALID_STATE",
        "Management service not initialized",
      );
    const account = this.configured.get(id);
    if (!account || !account.managers.includes(actor))
      throw new BridgeManagementError(
        "FORBIDDEN",
        "Management account access denied",
      );
    return account;
  }
  private adapter(id: string): BridgeManagementAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter)
      throw new BridgeManagementError(
        "INVALID_CONFIG",
        "Management account unavailable",
      );
    return adapter;
  }
  private async remoteAccount(
    account: ManagedAccountConfig,
  ): Promise<RemoteAccount> {
    const accounts = await this.adapter(account.id).accounts();
    const matches = accounts.filter(
      (remote) =>
        remote.owner === account.owner && remote.login_id === account.loginId,
    );
    if (matches.length !== 1)
      throw new BridgeManagementError(
        "LOGIN_REQUIRED",
        "Configured bridge login is unavailable",
      );
    return matches[0];
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  public async accounts(actor: string): Promise<AccountStatus[]> {
    if (!this.ready)
      throw new BridgeManagementError(
        "INVALID_STATE",
        "Management service not initialized",
      );
    return Promise.all(
      [...this.configured.values()]
        .filter((account) => account.managers.includes(actor))
        .map(async (account) => {
          const result: AccountStatus = {
            id: account.id,
            bridgeId: account.bridgeId,
            label: account.label,
            network: account.network,
            owner: account.owner,
            loginId: account.loginId,
            allowedRooms: [...account.allowedRooms],
            available: false,
            status: "unavailable",
            capabilities: [],
            pendingOperationId: this.pending.find(
              (entry) => entry.accountId === account.id,
            )?.operation.id,
          };
          try {
            const remote = await this.remoteAccount(account);
            result.available = true;
            result.status = remote.capabilities.length
              ? "available"
              : "unsupported";
            result.capabilities = [...remote.capabilities];
            result.name = remote.name;
          } catch (error: unknown) {
            result.status =
              error instanceof BridgeManagementError &&
              error.code === "LOGIN_REQUIRED"
                ? "login-required"
                : "unavailable";
            result.error =
              result.status === "login-required"
                ? "Configured account requires a bridge login"
                : "Configured bridge account is unavailable";
          }
          return result;
        }),
    );
  }
  public async chats(actor: string, accountId: string): Promise<RemoteChat[]> {
    const account = this.account(actor, accountId);
    await this.remoteAccount(account);
    return this.adapter(accountId).chats();
  }
  public async portals(
    actor: string,
    accountId: string,
  ): Promise<RemotePortal[]> {
    const account = this.account(actor, accountId);
    await this.remoteAccount(account);
    return this.adapter(accountId).portals();
  }
  private async room(
    actor: string,
    account: ManagedAccountConfig,
    roomId: string,
  ): Promise<void> {
    if (!account.allowedRooms.includes(roomId))
      throw new BridgeManagementError(
        "FORBIDDEN",
        "Room is not allowed for this account",
      );
    await this.authorizeRoom(actor, roomId);
  }
  public async execute(
    actor: string,
    input: OperationRequest,
  ): Promise<OperationResult> {
    if (!inputValidator(input))
      throw new BridgeManagementError(
        "INVALID_INPUT",
        "Invalid management operation",
      );
    const request = structuredClone(input);
    return this.serialize(async () => {
      const account = this.account(actor, request.accountId);
      if (this.pending.some((entry) => entry.accountId === account.id))
        throw new BridgeManagementError(
          "RECONCILE_REQUIRED",
          "An operation requires reconciliation",
        );
      const remote = await this.remoteAccount(account);
      if (!remote.capabilities.includes(request.action))
        throw new BridgeManagementError(
          "UNSUPPORTED",
          "Bridge does not advertise this operation",
        );
      const adapter = this.adapter(account.id);
      const portals = await adapter.portals();
      const matches = portals.filter(
        (portal) => portal.chat_id === request.chatId,
      );
      if (matches.length > 1)
        throw new BridgeManagementError(
          "INVALID_RESPONSE",
          "Bridge returned ambiguous portal mappings",
        );
      const previous = matches[0];
      if (request.action === "connect") {
        if (
          previous ||
          request.expectedRoomId !== undefined ||
          !request.roomId ||
          request.relay !== undefined
        )
          throw new BridgeManagementError(
            "CONFLICT",
            "Connect requires an unmapped chat and destination room",
          );
        if (!(await adapter.chats()).some((chat) => chat.id === request.chatId))
          throw new BridgeManagementError(
            "NOT_FOUND",
            "Chat is unavailable for this account",
          );
      } else {
        if (!previous || request.expectedRoomId !== previous.room_id)
          throw new BridgeManagementError(
            "CONFLICT",
            "Portal mapping changed; refresh before retrying",
          );
        await this.room(actor, account, previous.room_id);
      }
      if (
        request.action === "move" &&
        (!request.roomId || request.relay !== undefined)
      )
        throw new BridgeManagementError(
          "INVALID_INPUT",
          "Move requires a destination room",
        );
      if (
        request.action === "disconnect" &&
        (request.roomId !== undefined || request.relay !== undefined)
      )
        throw new BridgeManagementError(
          "INVALID_INPUT",
          "Disconnect accepts no destination or relay flag",
        );
      if (
        request.action === "set-relay" &&
        (request.roomId !== undefined || typeof request.relay !== "boolean")
      )
        throw new BridgeManagementError(
          "INVALID_INPUT",
          "Relay operation requires a boolean flag",
        );
      if (
        request.action !== "set-relay" &&
        request.relayAccountId !== undefined
      )
        throw new BridgeManagementError(
          "INVALID_INPUT",
          "Relay account only applies to relay operations",
        );
      let relayAccount: ManagedAccountConfig | undefined;
      if (request.action === "set-relay" && request.relay) {
        if (!request.relayAccountId)
          throw new BridgeManagementError(
            "INVALID_INPUT",
            "Select an authorized relay account",
          );
        relayAccount = this.account(actor, request.relayAccountId);
        if (relayAccount.bridgeId !== account.bridgeId)
          throw new BridgeManagementError(
            "FORBIDDEN",
            "Relay account must belong to the same bridge",
          );
        await this.remoteAccount(relayAccount);
        await this.room(actor, relayAccount, request.expectedRoomId!);
      } else if (request.relayAccountId !== undefined)
        throw new BridgeManagementError(
          "INVALID_INPUT",
          "Disabled relay accepts no account selection",
        );
      if (request.roomId) await this.room(actor, account, request.roomId);
      const operation: BridgeOperation = {
        id: randomUUID(),
        action: request.action,
        owner: account.owner,
        login_id: account.loginId,
        chat_id: request.chatId,
        expected_room_id: request.expectedRoomId,
        room_id: request.roomId,
        relay: request.relay,
        relay_owner: relayAccount?.owner,
        relay_login_id: relayAccount?.loginId,
      };
      const entry: JournalEntry = {
        accountId: account.id,
        actor,
        operation,
        createdAt: new Date().toISOString(),
      };
      await this.journal.begin(entry);
      this.pending.push(entry);
      let result: OperationResult;
      try {
        result = await adapter.execute(operation);
      } catch {
        throw new BridgeManagementError(
          "RECONCILE_REQUIRED",
          `Operation ${operation.id} has an unknown outcome`,
        );
      }
      return this.finish(entry, result);
    });
  }
  private async finish(
    entry: JournalEntry,
    result: OperationResult,
  ): Promise<OperationResult> {
    if (!operationResultValidator(result) || result.id !== entry.operation.id)
      throw new BridgeManagementError(
        "RECONCILE_REQUIRED",
        "Invalid operation completion response",
      );
    if (result.status === "pending") return result;
    if (result.status === "completed") {
      const operation = entry.operation;
      const valid =
        operation.action === "disconnect"
          ? result.portal === null
          : result.portal !== null &&
            result.portal.chat_id === operation.chat_id &&
            result.portal.room_id ===
              (operation.room_id ?? operation.expected_room_id) &&
            (operation.action !== "set-relay" ||
              (result.portal.relay === operation.relay &&
                (!operation.relay ||
                  (result.portal.relay_owner === operation.relay_owner &&
                    result.portal.relay_login_id ===
                      operation.relay_login_id))));
      if (!valid)
        throw new BridgeManagementError(
          "RECONCILE_REQUIRED",
          "Completed operation has unexpected portal state",
        );
    }
    try {
      await this.journal.complete(entry.operation.id, result);
    } catch {
      throw new BridgeManagementError(
        "RECONCILE_REQUIRED",
        "Could not persist operation completion",
      );
    }
    this.pending = this.pending.filter(
      (pending) => pending.operation.id !== entry.operation.id,
    );
    return result;
  }
  public async reconcile(
    actor: string,
    accountId: string,
  ): Promise<OperationResult | null> {
    return this.serialize(async () => {
      const account = this.account(actor, accountId);
      const entry = this.pending.find(
        (pending) => pending.accountId === accountId,
      );
      if (!entry) return null;
      if (
        entry.operation.owner !== account.owner ||
        entry.operation.login_id !== account.loginId
      )
        throw new BridgeManagementError(
          "RECONCILE_REQUIRED",
          "Pending operation belongs to a different configured login",
        );
      for (const roomId of new Set(
        [entry.operation.expected_room_id, entry.operation.room_id].filter(
          (room): room is string => room !== undefined,
        ),
      ))
        await this.room(actor, account, roomId);
      const result = await this.adapter(accountId).reconcile(entry.operation);
      return this.finish(entry, result);
    });
  }
}
