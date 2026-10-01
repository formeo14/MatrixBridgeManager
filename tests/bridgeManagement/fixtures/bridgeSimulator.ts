import type { DatabaseSync } from "node:sqlite";
import type { MatrixCommandClient } from "../../../src/bridgeManagement/CommandBridgeAdapter";
import { BRIDGE } from "./bridgeFixture";

export const BRIDGE_BOT = "@whatsappbot:bridge.test";
export const PREFIX = "!wa";

interface Sent {
  roomId: string;
  sender: string;
  body: string;
  eventId: string;
}

export class BridgeSimulator {
  public readonly sent: Sent[] = [];
  public readonly replies = new Map<string, string[]>();
  public readonly membership = new Map<string, string>();
  public relayEnabled = true;
  public silent = false;
  public deletesRooms = false;
  public overwriteUsed = false;
  private counter = 0;

  public constructor(private readonly db: DatabaseSync) {}

  public join(roomId: string, userId: string) {
    this.membership.set(`${roomId}|${userId}`, "join");
  }

  public client(userId: string): MatrixCommandClient {
    return {
      userId,
      membership: async (roomId, user) =>
        this.membership.get(`${roomId}|${user}`) ?? null,
      join: async (roomId) => {
        if (this.membership.get(`${roomId}|${userId}`) !== "invite")
          throw new Error("M_FORBIDDEN");
        this.join(roomId, userId);
      },
      invite: async (roomId, user) => {
        if (this.membership.get(`${roomId}|${userId}`) !== "join")
          throw new Error("M_FORBIDDEN");
        this.membership.set(
          `${roomId}|${user}`,
          user === BRIDGE_BOT ? "join" : "invite",
        );
      },
      sendText: async (roomId, body) => {
        const eventId = `$event${++this.counter}`;
        this.sent.push({ roomId, sender: userId, body, eventId });
        setTimeout(() => this.handle(roomId, userId, body, eventId), 5);
        return eventId;
      },
      repliesAfter: async (_roomId, eventId) => this.replies.get(eventId) ?? [],
      deletesRoomsOnCleanup: async () => this.deletesRooms,
    };
  }

  private portalInRoom(roomId: string) {
    return this.db
      .prepare(
        "SELECT id, receiver FROM portal WHERE bridge_id = ? AND mxid = ?",
      )
      .get(BRIDGE, roomId) as { id: string; receiver: string } | undefined;
  }

  private reply(eventId: string, text: string) {
    if (!this.silent)
      this.replies.set(eventId, [...(this.replies.get(eventId) ?? []), text]);
  }

  private handle(
    roomId: string,
    sender: string,
    body: string,
    eventId: string,
  ) {
    if (this.silent) return;
    if (this.membership.get(`${roomId}|${BRIDGE_BOT}`) !== "join") return;
    const [prefix, command, ...args] = body.split(" ");
    if (prefix !== PREFIX) return;
    const owner = (login: string) =>
      (
        this.db
          .prepare(
            "SELECT user_mxid FROM user_login WHERE bridge_id = ? AND id = ?",
          )
          .get(BRIDGE, login) as { user_mxid: string } | undefined
      )?.user_mxid;
    switch (command) {
      case "bridge": {
        if (this.portalInRoom(roomId))
          return this.reply(eventId, "This room is already bridged");
        if (args.includes("--overwrite")) this.overwriteUsed = true;
        const [login, chat] = args;
        if (owner(login) !== sender)
          return this.reply(eventId, `Login ${login} does not belong to you`);
        const portal = this.db
          .prepare("SELECT mxid FROM portal WHERE bridge_id = ? AND id = ?")
          .get(BRIDGE, chat) as { mxid: string | null } | undefined;
        if (!portal)
          return this.reply(eventId, `No portal found with ID ${chat}`);
        if (portal.mxid)
          return this.reply(
            eventId,
            "That chat is already bridged to another room. Use --overwrite to delete the existing room.",
          );
        this.db
          .prepare("UPDATE portal SET mxid = ? WHERE bridge_id = ? AND id = ?")
          .run(roomId, BRIDGE, chat);
        return this.reply(eventId, `Successfully plumbed this room to ${chat}`);
      }
      case "unbridge": {
        const portal = this.portalInRoom(roomId);
        if (!portal) return this.reply(eventId, "This isn't a portal room");
        this.db
          .prepare(
            "UPDATE portal SET mxid = NULL WHERE bridge_id = ? AND id = ?",
          )
          .run(BRIDGE, portal.id);
        this.membership.set(`${roomId}|${BRIDGE_BOT}`, "leave");
        return;
      }
      case "set-relay": {
        const portal = this.portalInRoom(roomId);
        if (!portal) return this.reply(eventId, "This isn't a portal room");
        if (!this.relayEnabled)
          return this.reply(eventId, "This bridge does not allow relay mode");
        if (owner(args[0]) !== sender)
          return this.reply(
            eventId,
            "Only bridge admins can set another user's login as the relay",
          );
        this.db
          .prepare(
            "UPDATE portal SET relay_bridge_id = ?, relay_login_id = ? WHERE bridge_id = ? AND id = ?",
          )
          .run(BRIDGE, args[0], BRIDGE, portal.id);
        return this.reply(
          eventId,
          "Messages sent by users who haven't logged in will now be relayed",
        );
      }
      case "unset-relay": {
        const portal = this.portalInRoom(roomId);
        if (!portal) return this.reply(eventId, "This isn't a portal room");
        this.db
          .prepare(
            "UPDATE portal SET relay_bridge_id = NULL, relay_login_id = NULL WHERE bridge_id = ? AND id = ?",
          )
          .run(BRIDGE, portal.id);
        return this.reply(
          eventId,
          "Messages from non-logged-in users will no longer be bridged",
        );
      }
    }
  }
}
