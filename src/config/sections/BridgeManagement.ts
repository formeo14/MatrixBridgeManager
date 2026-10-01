import {
  BridgeDatabaseConfig,
  BridgeManagementConfig,
  ManagedAccountConfig,
  ManagedBridgeConfig,
} from "../../bridgeManagement/Types";
import { ConfigError } from "../../Errors";

export interface BridgeManagementDatabaseYAML {
  type: "postgres" | "sqlite";
  path?: string;
  uriEnv?: string;
  host?: string;
  port?: number;
  name?: string;
  userEnv?: string;
  passwordEnv?: string;
}

export interface BridgeManagementBridgeYAML {
  id: string;
  network: string;
  botUserId: string;
  commandPrefix: string;
  databaseBridgeId?: string;
  database: BridgeManagementDatabaseYAML;
}

export interface BridgeManagementAccountYAML {
  id: string;
  bridge: string;
  label: string;
  owner: string;
  ownerTokenEnv?: string;
  loginId: string;
  managers: string[];
  allowedRooms: string[];
}

export interface BridgeManagementConfigYAML {
  statePath: string;
  bridges: BridgeManagementBridgeYAML[];
  accounts: BridgeManagementAccountYAML[];
  timeoutMs?: number;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MATRIX_USER = /^@[^:\s]+:\S+$/;
const MATRIX_ROOM = /^![^\s]+$/;
const IDENTIFIER = /^[a-zA-Z0-9_.-]+$/;

export function parseBridgeManagementConfig(
  value: BridgeManagementConfigYAML,
  env: NodeJS.ProcessEnv,
): BridgeManagementConfig {
  const fail = (reason: string): never => {
    throw new ConfigError("bridgeManagement", reason);
  };
  const nonEmpty = (field: unknown, name: string): string =>
    typeof field === "string" && field.trim()
      ? field
      : fail(`${name} is required`);
  const fromEnv = (name: string | undefined, field: string): string => {
    if (!name || !ENV_NAME.test(name))
      return fail(`${field} must name an environment variable`);
    const result = env[name];
    if (!result) return fail(`Environment variable ${name} is not set`);
    return result;
  };

  if (!value || typeof value !== "object") fail("must be an object");
  nonEmpty(value.statePath, "statePath");
  if (
    value.timeoutMs !== undefined &&
    (!Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 1000 ||
      value.timeoutMs > 120000)
  )
    fail("timeoutMs must be an integer from 1000 to 120000");
  if (!Array.isArray(value.bridges) || !value.bridges.length)
    fail("bridges must be a nonempty array");
  if (!Array.isArray(value.accounts) || !value.accounts.length)
    fail("accounts must be a nonempty array");

  const bridges = new Map<string, ManagedBridgeConfig>();
  for (const bridge of value.bridges) {
    if (!bridge || typeof bridge !== "object")
      fail("Every bridge must be an object");
    const id = nonEmpty(bridge.id, "Bridge id");
    if (!IDENTIFIER.test(id) || bridges.has(id))
      fail("Bridge IDs must be unique identifiers");
    const botUser = nonEmpty(bridge.botUserId, `Bridge ${id} botUserId`);
    if (!MATRIX_USER.test(botUser))
      fail(`Bridge ${id} botUserId must be a Matrix user ID`);
    const prefix = nonEmpty(bridge.commandPrefix, `Bridge ${id} commandPrefix`);
    if (/\s/.test(prefix))
      fail(`Bridge ${id} commandPrefix cannot contain spaces`);
    const db = bridge.database;
    let database: BridgeDatabaseConfig;
    if (db?.type === "sqlite") {
      database = {
        type: "sqlite",
        path: nonEmpty(db.path, `Bridge ${id} database.path`),
      };
    } else if (db?.type === "postgres") {
      if (db.uriEnv) {
        const uri = fromEnv(db.uriEnv, `Bridge ${id} database.uriEnv`);
        if (!/^postgres(ql)?:\/\//.test(uri))
          fail(`Bridge ${id} database URI must start with postgres://`);
        database = { type: "postgres", uri };
      } else {
        if (
          db.port !== undefined &&
          (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535)
        )
          fail(`Bridge ${id} database.port is invalid`);
        database = {
          type: "postgres",
          host: nonEmpty(db.host, `Bridge ${id} database.host`),
          port: db.port,
          database: nonEmpty(db.name, `Bridge ${id} database.name`),
          user: fromEnv(db.userEnv, `Bridge ${id} database.userEnv`),
          password: fromEnv(
            db.passwordEnv,
            `Bridge ${id} database.passwordEnv`,
          ),
        };
      }
    } else return fail(`Bridge ${id} database.type must be postgres or sqlite`);
    bridges.set(id, {
      id,
      network: nonEmpty(bridge.network, `Bridge ${id} network`),
      botUserId: botUser,
      commandPrefix: prefix,
      databaseBridgeId: bridge.databaseBridgeId || undefined,
      database,
    });
  }

  const ids = new Set<string>();
  const logins = new Set<string>();
  const ownerTokens: Record<string, string> = {};
  const accounts = value.accounts.map((account): ManagedAccountConfig => {
    if (!account || typeof account !== "object")
      fail("Every account must be an object");
    const id = nonEmpty(account.id, "Account id");
    if (!IDENTIFIER.test(id) || ids.has(id))
      fail("Account IDs must be unique identifiers");
    ids.add(id);
    const bridge =
      bridges.get(account.bridge) ??
      fail(`Account ${id} refers to an unknown bridge`);
    const owner = nonEmpty(account.owner, `Account ${id} owner`);
    if (!MATRIX_USER.test(owner))
      fail(`Account ${id} owner must be a Matrix user ID`);
    const loginId = nonEmpty(account.loginId, `Account ${id} loginId`);
    const login = JSON.stringify([bridge.id, loginId]);
    if (logins.has(login))
      fail("Each bridge login may be configured only once");
    logins.add(login);
    if (
      !Array.isArray(account.managers) ||
      !account.managers.length ||
      account.managers.some(
        (user) => typeof user !== "string" || !MATRIX_USER.test(user),
      )
    )
      fail("managers must contain explicit Matrix user IDs");
    if (
      !Array.isArray(account.allowedRooms) ||
      !account.allowedRooms.length ||
      account.allowedRooms.some(
        (room) => typeof room !== "string" || !MATRIX_ROOM.test(room),
      )
    )
      fail("allowedRooms must contain explicit Matrix room IDs");
    if (account.ownerTokenEnv) {
      const token = fromEnv(
        account.ownerTokenEnv,
        `Account ${id} ownerTokenEnv`,
      );
      if (ownerTokens[owner] && ownerTokens[owner] !== token)
        fail(`Accounts owned by ${owner} use different access tokens`);
      ownerTokens[owner] = token;
    }
    return {
      id,
      bridgeId: bridge.id,
      label: nonEmpty(account.label, `Account ${id} label`),
      network: bridge.network,
      owner,
      loginId,
      managers: [...account.managers],
      allowedRooms: [...account.allowedRooms],
    };
  });
  return {
    statePath: value.statePath,
    bridges: [...bridges.values()],
    accounts,
    ownerTokens,
    timeoutMs: value.timeoutMs,
  };
}
