# MatrixBridgeMerge

MatrixBridgeMerge links the same group from several messaging networks (WhatsApp, Signal, LINE, Telegram and other mautrix bridges) into one Matrix room. It runs as the `linker` bot inside this Hookshot build and is managed from a room widget or with text commands.

The bridges do not need to know about MatrixBridgeMerge. They run unmodified, with their usual configuration and database.

## How it works

| Step     | What MatrixBridgeMerge does                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover | Reads the bridge's own database through a read-only connection: logins (`user_login`), groups (`portal`) and which room each group is linked to.                                                                       |
| Change   | Sends the bridge's own commands as the account owner: `bridge <login> <chat>`, `unbridge`, `set-relay <login>` and `unset-relay`.                                                                                      |
| Confirm  | Reads the database again until the bridge has applied the change. If the bridge answers with an error, that error is shown. If it does not answer in time, the change is recorded as pending and can be checked later. |

Because changes go through the bridge's own commands, the bridge keeps control of its locks, caches and Matrix state. MatrixBridgeMerge never writes to a bridge database:

- SQLite databases are opened with SQLite's read-only flag.
- PostgreSQL sessions start with `default_transaction_read_only=on`, which is checked on every connection.
- Only a fixed set of `SELECT` statements is used.
- A dedicated database role with `SELECT` on `portal`, `user_login` and `user_portal` is recommended in addition.

A Matrix room can hold one group per bridge. A move is done as `unbridge` followed by `bridge` in the new room, so the previous room is never tombstoned or deleted. On standard homeservers `unbridge` only removes the bridge's own bot and ghost users from the room; members stay. If the homeserver supports Beeper room deletion, MatrixBridgeMerge refuses to disconnect or move, because the bridge would delete the whole room.

## Configuration

Credentials come from environment variables, the same ones the bridges use in their compose files.

```yaml
bridgeManagement:
  statePath: /data/bridge-merge.sqlite
  timeoutMs: 20000
  bridges:
    - id: whatsapp
      network: whatsapp
      botUserId: "@whatsappbot:example.com"
      commandPrefix: "!wa"
      database:
        type: postgres
        host: whatsapp-db
        port: 5432
        name: whatsapp
        userEnv: WHATSAPP_DB_USER
        passwordEnv: WHATSAPP_DB_PASSWORD
    - id: signal
      network: signal
      botUserId: "@signalbot:example.com"
      commandPrefix: "!signal"
      database:
        type: postgres
        uriEnv: SIGNAL_DB_URI
    - id: line
      network: line
      botUserId: "@linebot:example.com"
      commandPrefix: "!line"
      database:
        type: sqlite
        path: /bridges/line/line.db
  accounts:
    - id: whatsapp-shared
      bridge: whatsapp
      label: Shared WhatsApp
      owner: "@relay:example.com"
      ownerTokenEnv: RELAY_ACCESS_TOKEN
      loginId: "4915100000001"
      managers: ["@admin:example.com"]
      allowedRooms: ["!community:example.com"]
permissions:
  - actor: "@admin:example.com"
    services:
      - service: bridgeManagement
        level: manageConnections
```

| Field                                  | Meaning                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bridges[].botUserId`, `commandPrefix` | The bridge bot and command prefix from the bridge's config (`appservice.bot.username`, `bridge.command_prefix`). |
| `bridges[].database`                   | `postgres` with `uriEnv`, or with `host`, `port`, `name`, `userEnv`, `passwordEnv`; or `sqlite` with `path`.     |
| `bridges[].databaseBridgeId`           | Optional. Needed only when several bridges share one database.                                                   |
| `accounts[].owner`                     | Matrix user that is logged in to the bridge. Bridge commands are sent as this user.                              |
| `accounts[].ownerTokenEnv`             | Environment variable with that user's Matrix access token. Not needed when the owner is the `linker` bot itself. |
| `accounts[].loginId`                   | The login ID shown by the bridge's `list-logins` command.                                                        |
| `managers`, `allowedRooms`             | Who may use the account, and in which rooms.                                                                     |

The owner must be able to run the bridge's `bridge`, `unbridge` and relay commands. That means bridge permission level `user` or higher, power to send `m.bridge` state in the target room, and `bridge.relay.enabled: true` in the bridge config for relay.

Mutations also require the manager to be joined with power level 50 or the room's `state_default`, whichever is higher. The `linker` bot must be in the room.

## Widget API

Under `/widgetapi/v1/:roomId/bridge-management`:

| Method | Path                             | Result                                         |
| ------ | -------------------------------- | ---------------------------------------------- |
| GET    | `/rooms`                         | Rooms the manager may link groups into         |
| GET    | `/accounts`                      | Account availability and capabilities          |
| GET    | `/accounts/:accountId/chats`     | Groups of that login                           |
| GET    | `/accounts/:accountId/portals`   | Groups that are linked to a room               |
| POST   | `/operations`                    | `connect`, `move`, `disconnect` or `set-relay` |
| POST   | `/accounts/:accountId/reconcile` | Check a pending change                         |

## Text commands

```text
!hookshot bridge list
!hookshot bridge chats <accountId>
!hookshot bridge connect <accountId> <chatId>
!hookshot bridge move <accountId> <chatId> <!targetRoom>
!hookshot bridge disconnect <accountId> <chatId>
!hookshot bridge relay <accountId> <chatId> on [relayAccountId]
!hookshot bridge relay <accountId> <chatId> off
!hookshot bridge reconcile <accountId>
```

`bridge chats` shows group names to everyone in the room.

## Suggestions

The widget compares group names with the room name, or with a group already in the room. Names are compared after folding case, accents, punctuation and emoji, and ignoring network words such as "WhatsApp". Word overlap, typo tolerance and character trigrams (for Japanese, Chinese and Korean names) are combined. Groups that differ only in a number or letter, such as "Team A" and "Team B", are kept apart. A creation time can strengthen a name match but never creates a suggestion on its own. Only networks without a group in the room are suggested, at most two per network. Nothing is linked without a click.

## Limits

- Group discovery depends on the bridge having synced the group into its database.
- After a disconnect, the bridge may open a separate room for the group when its next message arrives.
- MatrixBridgeMerge works with bridges built on mautrix bridgev2. Older bridges with a different database schema are reported as unavailable.
