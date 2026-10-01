import type { MatrixClient } from "matrix-bot-sdk";
import type { MatrixCommandClient } from "./CommandBridgeAdapter";

const encode = encodeURIComponent;

export class BotSdkCommandClient implements MatrixCommandClient {
  private roomDeletion?: Promise<boolean>;

  public constructor(
    private readonly client: MatrixClient,
    public readonly userId: string,
  ) {}

  public async membership(
    roomId: string,
    userId: string,
  ): Promise<string | null> {
    try {
      const content = await this.client.getRoomStateEventContent(
        roomId,
        "m.room.member",
        userId,
      );
      return typeof content?.membership === "string"
        ? content.membership
        : null;
    } catch {
      return null;
    }
  }

  public async join(roomId: string): Promise<void> {
    await this.client.joinRoom(roomId);
  }

  public async invite(roomId: string, userId: string): Promise<void> {
    await this.client.inviteUser(userId, roomId);
  }

  public async sendText(roomId: string, body: string): Promise<string> {
    return this.client.sendMessage(roomId, { msgtype: "m.text", body });
  }

  public async repliesAfter(
    roomId: string,
    eventId: string,
    sender: string,
  ): Promise<string[]> {
    const context = await this.client.doRequest(
      "GET",
      `/_matrix/client/v3/rooms/${encode(roomId)}/context/${encode(eventId)}`,
      { limit: 20 },
    );
    const events: unknown[] = Array.isArray(context?.events_after)
      ? context.events_after
      : [];
    return events.flatMap((item) => {
      const event = item as {
        type?: string;
        sender?: string;
        content?: { body?: unknown };
      };
      return event.type === "m.room.message" &&
        event.sender === sender &&
        typeof event.content?.body === "string"
        ? [event.content.body]
        : [];
    });
  }

  public deletesRoomsOnCleanup(): Promise<boolean> {
    this.roomDeletion ??= this.client
      .doRequest("GET", "/_matrix/client/versions")
      .then(
        (versions) =>
          versions?.unstable_features?.["com.beeper.room_yeeting"] === true,
      )
      .catch(() => {
        this.roomDeletion = undefined;
        return true;
      });
    return this.roomDeletion;
  }
}
