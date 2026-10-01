export type BridgeAction = "connect" | "move" | "disconnect" | "set-relay";
export type BridgeDatabaseConfig =
  | { type: "sqlite"; path: string }
  | {
      type: "postgres";
      uri?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
    };
export interface ManagedBridgeConfig {
  id: string;
  network: string;
  botUserId: string;
  commandPrefix: string;
  databaseBridgeId?: string;
  database: BridgeDatabaseConfig;
}
export interface ManagedAccountConfig {
  id: string;
  bridgeId: string;
  label?: string;
  network?: string;
  owner: string;
  loginId: string;
  managers: string[];
  allowedRooms: string[];
}
export interface BridgeManagementConfig {
  statePath: string;
  bridges: ManagedBridgeConfig[];
  accounts: ManagedAccountConfig[];
  ownerTokens: Record<string, string>;
  timeoutMs?: number;
}
export interface RemoteAccount {
  owner: string;
  login_id: string;
  name: string;
  capabilities: BridgeAction[];
}
export interface RemoteChat {
  id: string;
  name: string;
  created_at?: string;
}
export interface RemotePortal {
  chat_id: string;
  room_id: string;
  relay: boolean;
  relay_owner?: string;
  relay_login_id?: string;
}
export interface BridgeOperation {
  id: string;
  action: BridgeAction;
  owner: string;
  login_id: string;
  chat_id: string;
  expected_room_id?: string;
  room_id?: string;
  relay?: boolean;
  relay_owner?: string;
  relay_login_id?: string;
}
export interface OperationRequest {
  accountId: string;
  action: BridgeAction;
  chatId: string;
  expectedRoomId?: string;
  roomId?: string;
  relay?: boolean;
  relayAccountId?: string;
}
export interface OperationResult {
  version: 1;
  id: string;
  status: "completed" | "rejected" | "pending";
  portal: RemotePortal | null;
  error?: string;
}
export interface AccountStatus {
  id: string;
  bridgeId: string;
  label?: string;
  network?: string;
  owner: string;
  loginId: string;
  allowedRooms: string[];
  available: boolean;
  status: "available" | "login-required" | "unavailable" | "unsupported";
  capabilities: BridgeAction[];
  name?: string;
  error?: string;
  pendingOperationId?: string;
}
export interface BridgeManagementAdapter {
  accounts(): Promise<RemoteAccount[]>;
  chats(): Promise<RemoteChat[]>;
  portals(): Promise<RemotePortal[]>;
  execute(operation: BridgeOperation): Promise<OperationResult>;
  reconcile(operation: BridgeOperation): Promise<OperationResult>;
}
export type RoomAuthorizer = (actor: string, roomId: string) => Promise<void>;
export interface JournalEntry {
  accountId: string;
  actor: string;
  operation: BridgeOperation;
  createdAt: string;
}
export class BridgeManagementError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
