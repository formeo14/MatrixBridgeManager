import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BridgeAPI, BridgeConfig } from "../../BridgeAPI";
import type {
  AccountStatus,
  BridgeAction,
  OperationRequest,
  OperationResult,
  RemoteChat,
  RemotePortal,
} from "../../../src/bridgeManagement/Types";
import { suggestMatches } from "../../../src/bridgeManagement/Matching";
import type { MatchResult } from "../../../src/bridgeManagement/Matching";
import { BridgeContext } from "../../context";
import styles from "./BridgeManagementConfig.module.scss";

export type BridgeManagementWorkspaceAPI = Pick<
  BridgeAPI,
  | "getManagedBridgeAccounts"
  | "getManagedBridgeRooms"
  | "getManagedBridgeChats"
  | "getManagedBridgePortals"
  | "runManagedBridgeOperation"
  | "reconcileManagedBridgeAccount"
>;

interface AccountData {
  chats: RemoteChat[];
  portals: RemotePortal[];
  errors: string[];
  portalsKnown: boolean;
}

interface Group {
  key: string;
  network: string;
  name: string;
  createdAt?: string;
  account: AccountStatus;
  chat: RemoteChat;
  portal?: RemotePortal;
}

interface Confirmation {
  operation: OperationRequest;
  name: string;
}

interface Banner {
  tone: "success" | "info" | "critical";
  text: string;
}

interface WorkspaceProps {
  api: BridgeManagementWorkspaceAPI;
  roomId: string;
  showHeader?: boolean;
}

const NETWORKS: Record<string, { name: string; code: string }> = {
  whatsapp: { name: "WhatsApp", code: "WA" },
  signal: { name: "Signal", code: "SG" },
  telegram: { name: "Telegram", code: "TG" },
  line: { name: "LINE", code: "LN" },
  discord: { name: "Discord", code: "DC" },
  slack: { name: "Slack", code: "SL" },
};

const STATUS: Record<AccountStatus["status"], string> = {
  available: "Ready",
  "login-required": "Login required",
  unavailable: "Offline",
  unsupported: "Read only",
};

const CONFIDENCE: Record<MatchResult["confidence"], string> = {
  strong: "Strong match",
  likely: "Likely match",
  possible: "Possible match",
};

function networkKey(account: AccountStatus): string {
  const raw = (account.network ?? account.bridgeId).toLowerCase();
  return Object.keys(NETWORKS).find((key) => raw.includes(key)) ?? raw;
}

function networkName(key: string): string {
  return NETWORKS[key]?.name ?? key;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function NetworkMark({ network }: { network: string }) {
  return (
    <span className={styles.mark} data-network={network} aria-hidden="true">
      {NETWORKS[network]?.code ?? network.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function BridgeManagementWorkspace({
  api,
  roomId,
  showHeader = true,
}: WorkspaceProps) {
  const [accounts, setAccounts] = useState<AccountStatus[]>([]);
  const [rooms, setRooms] = useState<Array<{ id: string; name: string }>>([]);
  const [destination, setDestination] = useState(roomId);
  const [owner, setOwner] = useState("");
  const [data, setData] = useState<Record<string, AccountData>>({});
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [network, setNetwork] = useState("");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [roomError, setRoomError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [relayAccount, setRelayAccount] = useState("");
  const [autoRelay, setAutoRelay] = useState(true);
  const [reference, setReference] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setDestination(roomId);
    setReference("");
    setConfirmation(null);
    setExpanded(null);
  }, [roomId]);

  useEffect(() => {
    if (confirmation && !dialogRef.current?.open)
      dialogRef.current?.showModal();
    if (!confirmation && dialogRef.current?.open) dialogRef.current.close();
  }, [confirmation]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRoomError("");
    async function load() {
      const [accountResult, roomResult] = await Promise.allSettled([
        api.getManagedBridgeAccounts(roomId),
        api.getManagedBridgeRooms(roomId),
      ]);
      if (cancelled) return;
      if (roomResult.status === "fulfilled") {
        setRooms(roomResult.value);
        setDestination((previous) =>
          roomResult.value.some((item) => item.id === previous)
            ? previous
            : (roomResult.value[0]?.id ?? ""),
        );
      } else {
        setRooms([]);
        setDestination("");
        setRoomError(errorText(roomResult.reason));
      }
      if (accountResult.status === "rejected") {
        setBanner({ tone: "critical", text: errorText(accountResult.reason) });
        setAccounts([]);
        setData({});
        setLoading(false);
        return;
      }
      const nextAccounts = accountResult.value;
      setAccounts(nextAccounts);
      setOwner((previous) =>
        nextAccounts.some((item) => item.owner === previous)
          ? previous
          : (nextAccounts[0]?.owner ?? ""),
      );
      const entries = await Promise.all(
        nextAccounts
          .filter((account) => account.available)
          .map(async (account) => {
            const [chats, portals] = await Promise.allSettled([
              api.getManagedBridgeChats(roomId, account.id),
              api.getManagedBridgePortals(roomId, account.id),
            ]);
            const entry: AccountData = {
              chats: chats.status === "fulfilled" ? chats.value : [],
              portals: portals.status === "fulfilled" ? portals.value : [],
              errors: [chats, portals].flatMap((result) =>
                result.status === "rejected" ? [errorText(result.reason)] : [],
              ),
              portalsKnown: portals.status === "fulfilled",
            };
            return [account.id, entry] as const;
          }),
      );
      if (cancelled) return;
      setData(Object.fromEntries(entries));
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, roomId, refresh]);

  const owners = [...new Set(accounts.map((account) => account.owner))];
  const ownerAccounts = useMemo(
    () => accounts.filter((account) => account.owner === owner),
    [accounts, owner],
  );
  const networks = [...new Set(ownerAccounts.map(networkKey))].sort();
  const roomName = (id: string) =>
    rooms.find((room) => room.id === id)?.name ?? id;

  const groups = useMemo<Group[]>(
    () =>
      ownerAccounts.flatMap((account) => {
        const entry = data[account.id];
        if (!entry) return [];
        const chats = [...entry.chats];
        for (const portal of entry.portals)
          if (!chats.some((chat) => chat.id === portal.chat_id))
            chats.push({ id: portal.chat_id, name: portal.chat_id });
        return chats.map((chat) => ({
          key: `${account.id}:${chat.id}`,
          network: networkKey(account),
          name: chat.name,
          createdAt: chat.created_at,
          account,
          chat,
          portal: entry.portals.find((portal) => portal.chat_id === chat.id),
        }));
      }),
    [ownerAccounts, data],
  );

  const connected = groups.filter(
    (group) => group.portal?.room_id === destination,
  );
  const filledNetworks = useMemo(
    () => new Set(connected.map((group) => group.network)),
    [connected.map((group) => group.network).join()],
  );
  const openNetworks = networks.filter((key) => !filledNetworks.has(key));
  const actionableNetworks = openNetworks.filter((key) =>
    ownerAccounts.some(
      (account) => networkKey(account) === key && account.available,
    ),
  );
  const referenceGroup = groups.find((group) => group.key === reference);
  const referenceName = referenceGroup?.name ?? roomName(destination);

  const suggestions = useMemo(() => {
    if (!destination) return [];
    return suggestMatches(
      {
        name: referenceName,
        createdAt: referenceGroup?.createdAt,
        network: referenceGroup?.network,
      },
      groups.filter((group) => group.portal?.room_id !== destination),
      { excludeNetworks: filledNetworks },
    );
  }, [groups, destination, referenceName, referenceGroup, filledNetworks]);

  const browse = groups.filter(
    (group) =>
      (!network || group.network === network) &&
      (!search ||
        group.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
  );

  const blocked = (group: Group, action: BridgeAction): string | undefined => {
    if (!destination) return "Choose a room first";
    if (!group.account.available) return STATUS[group.account.status];
    if (group.account.pendingOperationId)
      return "A previous change is waiting for confirmation";
    if (!data[group.account.id]?.portalsKnown)
      return "Connections could not be loaded";
    if (!group.account.allowedRooms.includes(destination))
      return "This account is not allowed in this room";
    if (!group.account.capabilities.includes(action))
      return "This account is read only";
    if (
      (action === "connect" || action === "move") &&
      filledNetworks.has(group.network)
    )
      return `This room already has a ${networkName(group.network)} group`;
    return undefined;
  };

  const operationFor = (
    group: Group,
    action: BridgeAction,
  ): OperationRequest => ({
    accountId: group.account.id,
    action,
    chatId: group.chat.id,
    ...(group.portal ? { expectedRoomId: group.portal.room_id } : {}),
    ...(action === "connect" || action === "move"
      ? { roomId: destination }
      : {}),
  });

  function report(result: OperationResult | null, success: string) {
    if (!result)
      setBanner({
        tone: "info",
        text: "No change is waiting for confirmation.",
      });
    else if (result.status === "completed")
      setBanner({ tone: "success", text: success });
    else if (result.status === "pending")
      setBanner({
        tone: "info",
        text: "The bridge has not confirmed this change yet. Check again in a moment.",
      });
    else
      setBanner({
        tone: "critical",
        text: result.error ?? "The bridge refused this change.",
      });
  }

  async function operate(operation: OperationRequest, name: string) {
    setWorking(`${operation.accountId}:${operation.chatId}`);
    setBanner(null);
    setConfirmation(null);
    const verb = {
      connect: "is connected",
      move: "moved here",
      disconnect: "is disconnected",
      "set-relay": operation.relay
        ? "now relays messages"
        : "no longer relays messages",
    }[operation.action];
    try {
      const result = await api.runManagedBridgeOperation(roomId, operation);
      const account = accounts.find((item) => item.id === operation.accountId);
      const relayAfter =
        result.status === "completed" &&
        (operation.action === "connect" || operation.action === "move") &&
        autoRelay &&
        account?.capabilities.includes("set-relay") &&
        !result.portal?.relay;
      if (!relayAfter) report(result, `${name} ${verb}.`);
      else {
        try {
          const relay = await api.runManagedBridgeOperation(roomId, {
            accountId: operation.accountId,
            chatId: operation.chatId,
            action: "set-relay",
            expectedRoomId: operation.roomId,
            relay: true,
            relayAccountId: operation.accountId,
          });
          if (relay.status === "rejected")
            setBanner({
              tone: "critical",
              text: `${name} ${verb}, but relay stayed off: ${relay.error ?? "the bridge refused it"}.`,
            });
          else report(relay, `${name} ${verb} with relay on.`);
        } catch (cause) {
          setBanner({
            tone: "critical",
            text: `${name} ${verb}, but relay stayed off: ${errorText(cause)}`,
          });
        }
      }
    } catch (cause) {
      setBanner({ tone: "critical", text: errorText(cause) });
    } finally {
      setWorking(null);
      setRefresh((value) => value + 1);
    }
  }

  async function reconcile(account: AccountStatus) {
    setWorking(account.id);
    setBanner(null);
    try {
      report(
        await api.reconcileManagedBridgeAccount(roomId, account.id),
        "The pending change is confirmed.",
      );
    } catch (cause) {
      setBanner({ tone: "critical", text: errorText(cause) });
    } finally {
      setWorking(null);
      setRefresh((value) => value + 1);
    }
  }

  function connectAction(group: Group, variant: "primary" | "secondary") {
    if (group.portal?.room_id === destination)
      return <span className={styles.here}>In this room</span>;
    const action = group.portal ? "move" : "connect";
    const reason = blocked(group, action);
    return (
      <button
        type="button"
        className={variant === "primary" ? styles.primary : styles.secondary}
        disabled={!!working || loading || !!reason}
        title={reason}
        aria-label={`${group.portal ? "Move" : "Connect"} ${group.name}`}
        onClick={() =>
          group.portal
            ? setConfirmation({
                operation: operationFor(group, "move"),
                name: group.name,
              })
            : operate(operationFor(group, "connect"), group.name)
        }
      >
        {working === group.key
          ? "Working…"
          : group.portal
            ? "Move here"
            : "Connect"}
      </button>
    );
  }

  function openManage(group: Group) {
    setExpanded((previous) => (previous === group.key ? null : group.key));
    setRelayAccount(
      accounts.find(
        (account) =>
          account.available &&
          account.bridgeId === group.account.bridgeId &&
          account.owner === group.portal?.relay_owner &&
          account.loginId === group.portal?.relay_login_id,
      )?.id ?? group.account.id,
    );
  }

  return (
    <div className={styles.root} aria-busy={loading}>
      <header className={styles.toolbar}>
        <div className={styles.roomPicker}>
          <label htmlFor="bridge-destination" className={styles.label}>
            {showHeader ? "Linked groups for" : "Room"}
          </label>
          <select
            id="bridge-destination"
            aria-label="Destination room"
            disabled={!!working || loading || !rooms.length}
            value={destination}
            onChange={(event) => {
              setDestination(event.currentTarget.value);
              setExpanded(null);
              setReference("");
            }}
          >
            <option value="" disabled>
              {loading ? "Loading rooms…" : "Choose a room"}
            </option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          disabled={!!working || loading}
          aria-label="Refresh"
          title="Refresh"
          onClick={() => {
            setBanner(null);
            setExpanded(null);
            setRefresh((value) => value + 1);
          }}
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path
              d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 3.5v3h-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      <div className={styles.accounts}>
        <span className={styles.accountsOwner}>
          Acting as{" "}
          {owners.length > 1 ? (
            <select
              id="bridge-owner"
              className={styles.inlineSelect}
              aria-label="Account owner"
              disabled={!!working}
              value={owner}
              onChange={(event) => {
                setOwner(event.currentTarget.value);
                setNetwork("");
                setExpanded(null);
                setReference("");
              }}
            >
              {owners.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : (
            <span className={styles.mono}>{owner || "no account"}</span>
          )}
        </span>
        <ul className={styles.statusList} aria-label="Network accounts">
          {ownerAccounts.map((account) => (
            <li
              key={account.id}
              className={styles.status}
              data-state={
                account.pendingOperationId ? "pending" : account.status
              }
              title={account.error ?? account.label ?? account.name}
            >
              <span className={styles.dot} />
              {networkName(networkKey(account))}
              {(account.status !== "available" ||
                account.pendingOperationId) && (
                <span className={styles.statusText}>
                  {account.pendingOperationId
                    ? "Change pending"
                    : STATUS[account.status]}
                </span>
              )}
              {account.pendingOperationId && (
                <button
                  type="button"
                  className={styles.link}
                  disabled={!!working}
                  onClick={() => reconcile(account)}
                >
                  Check
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {(banner || roomError) && (
        <div
          className={styles.banner}
          data-tone={banner?.tone ?? "critical"}
          role={banner && banner.tone !== "critical" ? "status" : "alert"}
        >
          <span>
            {banner?.text ?? `Rooms could not be loaded: ${roomError}`}
          </span>
          {banner && (
            <button
              type="button"
              className={styles.dismiss}
              aria-label="Dismiss"
              onClick={() => setBanner(null)}
            >
              ×
            </button>
          )}
        </div>
      )}
      {ownerAccounts.flatMap((account) =>
        (data[account.id]?.errors ?? []).map((message, index) => (
          <div
            key={`${account.id}-${index}`}
            className={styles.banner}
            data-tone="critical"
          >
            <span>
              {networkName(networkKey(account))}: {message}
            </span>
          </div>
        )),
      )}

      <section className={styles.section} aria-labelledby="bridge-linked">
        <div className={styles.sectionHead}>
          <h2 id="bridge-linked">In this room</h2>
          <span className={styles.count}>
            {connected.length} of {networks.length} networks
          </span>
        </div>
        <ul className={styles.list}>
          {connected.map((group) => (
            <li key={group.key} className={styles.item}>
              <div className={styles.row}>
                <NetworkMark network={group.network} />
                <div className={styles.text}>
                  <span className={styles.name}>{group.name}</span>
                  <span className={styles.meta}>
                    {networkName(group.network)} ·{" "}
                    <span
                      className={styles.relay}
                      data-relay={group.portal?.relay ? "on" : "off"}
                    >
                      {group.portal?.relay ? "Relay on" : "Relay off"}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.secondary}
                  aria-expanded={expanded === group.key}
                  disabled={!!working}
                  onClick={() => openManage(group)}
                >
                  {expanded === group.key ? "Close" : "Manage"}
                </button>
              </div>
              {expanded === group.key && (
                <ManagePanel
                  group={group}
                  accounts={accounts}
                  destination={destination}
                  relayAccount={relayAccount}
                  setRelayAccount={setRelayAccount}
                  disabled={!!working}
                  blocked={blocked}
                  onRelay={(relay) =>
                    operate(
                      {
                        ...operationFor(group, "set-relay"),
                        relay,
                        ...(relay ? { relayAccountId: relayAccount } : {}),
                      },
                      group.name,
                    )
                  }
                  onDisconnect={() =>
                    setConfirmation({
                      operation: operationFor(group, "disconnect"),
                      name: group.name,
                    })
                  }
                />
              )}
            </li>
          ))}
          {!loading &&
            openNetworks.map((key) => (
              <li key={`open-${key}`} className={styles.item} data-empty="true">
                <div className={styles.row}>
                  <NetworkMark network={key} />
                  <div className={styles.text}>
                    <span className={styles.emptyName}>
                      No {networkName(key)} group yet
                    </span>
                    <span className={styles.meta}>
                      {suggestions.some(
                        (match) => match.candidate.network === key,
                      )
                        ? "See suggestions below"
                        : "Choose one from All groups"}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          {loading && (
            <li className={styles.item}>
              <div className={styles.row}>
                <span className={styles.skeleton} />
                <span className={styles.meta}>
                  Loading groups and connections…
                </span>
              </div>
            </li>
          )}
        </ul>
      </section>

      {!loading && actionableNetworks.length > 0 && (
        <section className={styles.section} aria-labelledby="bridge-suggested">
          <div className={styles.sectionHead}>
            <h2 id="bridge-suggested">Suggested</h2>
            <label className={styles.matchBy} htmlFor="bridge-reference">
              <span>Compare with</span>
              <select
                id="bridge-reference"
                aria-label="Matching reference"
                className={styles.inlineSelect}
                value={reference}
                onChange={(event) => setReference(event.currentTarget.value)}
              >
                <option value="">Room name</option>
                {connected.map((group) => (
                  <option key={group.key} value={group.key}>
                    {group.name} ({networkName(group.network)})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {suggestions.length ? (
            <ul className={styles.list}>
              {suggestions.map((match) => {
                const group = match.candidate;
                return (
                  <li key={group.key} className={styles.item}>
                    <div className={styles.row}>
                      <NetworkMark network={group.network} />
                      <div className={styles.text}>
                        <span className={styles.name}>{group.name}</span>
                        <span className={styles.meta}>
                          <span
                            className={styles.confidence}
                            data-confidence={match.confidence}
                          >
                            {CONFIDENCE[match.confidence]}
                          </span>
                          {match.reasons.join(", ")}
                          {group.portal &&
                            ` · now in ${roomName(group.portal.room_id)}`}
                        </span>
                      </div>
                      {connectAction(group, "primary")}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={styles.hint}>
              No group names resemble “{referenceName}”. Browse all groups
              below.
            </p>
          )}
          <label className={styles.check} htmlFor="bridge-auto-relay">
            <input
              id="bridge-auto-relay"
              type="checkbox"
              checked={autoRelay}
              disabled={!!working}
              onChange={(event) => setAutoRelay(event.currentTarget.checked)}
            />
            Turn on relay after connecting
          </label>
        </section>
      )}

      <section className={styles.section}>
        <button
          type="button"
          id="bridge-all"
          className={styles.disclosure}
          aria-expanded={browseOpen}
          onClick={() => setBrowseOpen((value) => !value)}
        >
          <span>All groups</span>
          <span className={styles.count}>{groups.length}</span>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path
              d={browseOpen ? "M3 7.5 6 4.5 9 7.5" : "M3 4.5 6 7.5 9 4.5"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </button>
        {browseOpen && (
          <>
            <div className={styles.filters}>
              <input
                id="bridge-search"
                type="search"
                aria-label="Search groups"
                placeholder="Search groups"
                value={search}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
              <div
                className={styles.segmented}
                role="group"
                aria-label="Network"
              >
                {["", ...networks].map((key) => (
                  <button
                    key={key || "all"}
                    type="button"
                    aria-pressed={network === key}
                    onClick={() => setNetwork(key)}
                  >
                    {key ? networkName(key) : "All"}
                  </button>
                ))}
              </div>
            </div>
            {browse.length ? (
              <ul className={`${styles.list} ${styles.dense}`}>
                {browse.map((group) => (
                  <li key={group.key} className={styles.item}>
                    <div className={styles.row}>
                      <NetworkMark network={group.network} />
                      <div className={styles.text}>
                        <span className={styles.name}>{group.name}</span>
                        <span className={styles.meta}>
                          {group.portal
                            ? group.portal.room_id === destination
                              ? "In this room"
                              : `In ${roomName(group.portal.room_id)}`
                            : "Not linked"}
                        </span>
                      </div>
                      {group.portal?.room_id !== destination &&
                        connectAction(group, "secondary")}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.hint}>
                {groups.length
                  ? "No groups match this search."
                  : "No groups yet. Groups appear once the bridge account has synced them."}
              </p>
            )}
          </>
        )}
      </section>

      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby="bridge-confirm-title"
        onCancel={() => setConfirmation(null)}
        onClose={() => setConfirmation(null)}
      >
        {confirmation && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void operate(confirmation.operation, confirmation.name);
            }}
          >
            <h2 id="bridge-confirm-title">
              {confirmation.operation.action === "move"
                ? `Move ${confirmation.name} here?`
                : `Disconnect ${confirmation.name}?`}
            </h2>
            <dl className={styles.facts}>
              <dt>From</dt>
              <dd>{roomName(confirmation.operation.expectedRoomId ?? "")}</dd>
              {confirmation.operation.action === "move" && (
                <>
                  <dt>To</dt>
                  <dd>{roomName(confirmation.operation.roomId ?? "")}</dd>
                </>
              )}
            </dl>
            <p className={styles.hint}>
              {confirmation.operation.action === "move"
                ? "New messages will arrive in this room. Earlier messages stay where they are, and the previous room is kept."
                : "The bridge stops forwarding this group. The room and its members stay. The bridge may open a separate room for the group when its next message arrives."}
            </p>
            <div className={styles.actions}>
              <span className={styles.spacer} />
              <button
                type="button"
                className={styles.secondary}
                autoFocus
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={
                  confirmation.operation.action === "disconnect"
                    ? styles.danger
                    : styles.primary
                }
                disabled={!!working || loading}
              >
                {confirmation.operation.action === "move"
                  ? "Move"
                  : "Disconnect"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

interface ManagePanelProps {
  group: Group;
  accounts: AccountStatus[];
  destination: string;
  relayAccount: string;
  setRelayAccount: (value: string) => void;
  disabled: boolean;
  blocked: (group: Group, action: BridgeAction) => string | undefined;
  onRelay: (relay: boolean) => void;
  onDisconnect: () => void;
}

function ManagePanel({
  group,
  accounts,
  destination,
  relayAccount,
  setRelayAccount,
  disabled,
  blocked,
  onRelay,
  onDisconnect,
}: ManagePanelProps) {
  const relays = accounts.filter(
    (account) =>
      account.available &&
      account.bridgeId === group.account.bridgeId &&
      account.allowedRooms.includes(destination),
  );
  const relayBlocked = blocked(group, "set-relay");
  const disconnectBlocked = blocked(group, "disconnect");
  const unchanged =
    !!group.portal?.relay &&
    relays.find((account) => account.id === relayAccount)?.loginId ===
      group.portal.relay_login_id;
  const id = `relay-${group.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <div className={styles.panel}>
      <div className={styles.field}>
        <label htmlFor={id}>Relay through</label>
        <select
          id={id}
          value={relayAccount}
          disabled={disabled || !relays.length}
          onChange={(event) => setRelayAccount(event.currentTarget.value)}
        >
          {relays.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label ?? account.name ?? account.loginId}
            </option>
          ))}
        </select>
        <p className={styles.hint}>
          {group.portal?.relay
            ? `People without a ${networkName(group.network)} account are relayed as ${group.portal.relay_owner ?? "the relay account"}.`
            : `Messages from people without a ${networkName(group.network)} account are not forwarded.`}
        </p>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.dangerQuiet}
          disabled={disabled || !!disconnectBlocked}
          title={disconnectBlocked}
          onClick={onDisconnect}
        >
          Disconnect
        </button>
        <span className={styles.spacer} />
        {group.portal?.relay && (
          <button
            type="button"
            className={styles.secondary}
            disabled={disabled || !!relayBlocked}
            title={relayBlocked}
            onClick={() => onRelay(false)}
          >
            Turn off relay
          </button>
        )}
        <button
          type="button"
          className={styles.primary}
          disabled={
            disabled ||
            !!relayBlocked ||
            unchanged ||
            !relays.some((account) => account.id === relayAccount)
          }
          title={relayBlocked}
          onClick={() => onRelay(true)}
        >
          {group.portal?.relay ? "Change relay" : "Turn on relay"}
        </button>
      </div>
    </div>
  );
}

const BridgeManagementConfig: BridgeConfig = ({ roomId, showHeader }) => {
  const { bridgeApi } = useContext(BridgeContext);
  return (
    <BridgeManagementWorkspace
      api={bridgeApi}
      roomId={roomId}
      showHeader={showHeader}
    />
  );
};
export default BridgeManagementConfig;
