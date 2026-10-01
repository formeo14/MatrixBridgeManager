const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "../../../public");
const output = path.join(__dirname, "screenshots");
const owner = "@linker-relay:britstadt.test";
const rooms = [
  { id: "!volunteers:britstadt.test", name: "Britstadt Volunteers" },
  { id: "!training:britstadt.test", name: "Training & Exercises" },
  { id: "!archive:britstadt.test", name: "Archive 2025" },
];
const allowedRooms = rooms.map((room) => room.id);
const accounts = [
  ["whatsapp", "Shared WhatsApp", "available"],
  ["signal", "Shared Signal", "available"],
  ["line", "Shared LINE", "available"],
  ["telegram", "Shared Telegram", "login-required"],
].map(([network, label, status]) => ({
  id: network,
  bridgeId: network,
  label,
  network,
  owner,
  loginId: `${network}-login`,
  allowedRooms,
  available: status === "available",
  status,
  capabilities:
    status === "available"
      ? ["connect", "move", "disconnect", "set-relay"]
      : [],
  ...(status === "available"
    ? { name: label }
    : { error: "Configured account requires a bridge login" }),
}));
const chats = {
  whatsapp: [
    { id: "120363001@g.us", name: "Britstadt Volunteers" },
    { id: "120363002@g.us", name: "Training & Exercises" },
    { id: "120363003@g.us", name: "Equipment & Logistics" },
  ],
  signal: [
    { id: "sg-volunteers", name: "Britstadt Volunteers 🚒" },
    { id: "sg-training", name: "Training and Exercises" },
    { id: "sg-board", name: "Board" },
  ],
  line: [
    { id: "c1a2b3", name: "Britstadt volunteer" },
    { id: "c4d5e6", name: "Japan Exchange Team" },
  ],
};
const portals = {
  whatsapp: [
    {
      chat_id: "120363001@g.us",
      room_id: rooms[0].id,
      relay: true,
      relay_owner: owner,
      relay_login_id: "whatsapp-login",
    },
  ],
  signal: [],
  line: [{ chat_id: "c1a2b3", room_id: rooms[2].id, relay: false }],
};
const operations = [];

function operate(input) {
  const collection = portals[input.accountId];
  let portal = collection.find((item) => item.chat_id === input.chatId);
  if (input.action === "connect") {
    assert.equal(portal, undefined);
    portal = { chat_id: input.chatId, room_id: input.roomId, relay: false };
    collection.push(portal);
  } else {
    assert.equal(input.expectedRoomId, portal.room_id);
    if (input.action === "move") portal.room_id = input.roomId;
    if (input.action === "disconnect") {
      collection.splice(collection.indexOf(portal), 1);
      portal = null;
    }
    if (input.action === "set-relay") {
      portal.relay = input.relay;
      portal.relay_owner = input.relay ? owner : undefined;
      portal.relay_login_id = input.relay
        ? `${input.accountId}-login`
        : undefined;
    }
  }
  operations.push(input);
  return {
    version: 1,
    id: `sample-${operations.length}`,
    status: "completed",
    portal,
  };
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname === "/demo") {
        const scheme = url.searchParams.get("scheme") ?? "light";
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html><head><meta charset="utf-8"><title>MatrixBridgeMerge</title></head><body style="margin:0;background:${scheme === "dark" ? "#101317" : "#fff"}"><iframe id="widget" style="display:block;border:0;width:100%;height:100vh"></iframe><script>
          window.addEventListener("message", (event) => {
            const message = event.data;
            if (!message || message.api !== "fromWidget" || message.response) return;
            const response = message.action === "supported_api_versions" ? { supported_versions: [] } : {};
            event.source.postMessage({ ...message, response }, event.origin);
          });
          localStorage.setItem("hookshot-sessionToken", "sample-session");
          const frame = document.getElementById("widget");
          frame.onload = () => frame.contentWindow.postMessage({ api: "toWidget", widgetId: "sample", requestId: "caps", action: "capabilities", data: {} }, "*");
          frame.src = ${JSON.stringify(`/widgetapi/v1/static/#?widgetId=sample&roomId=${encodeURIComponent(rooms[0].id)}&kind=roomConfig&serviceScope=bridgeManagement`)};
        </script></body></html>`);
        return;
      }
      const relative = decodeURIComponent(
        url.pathname.replace("/widgetapi/v1/static", ""),
      );
      const filename = path.resolve(
        root,
        "." + (relative === "/" ? "/index.html" : relative),
      );
      if (!filename.startsWith(root + path.sep))
        throw new Error("Invalid path");
      const types = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      response.setHeader(
        "Content-Type",
        types[path.extname(filename)] || "application/octet-stream",
      );
      response.end(await fs.readFile(filename));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"],
  });
  const failures = [];
  try {
    async function open(scheme, width, height) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      });
      page.on("pageerror", (error) => failures.push(error.message));
      await page.route("**/widgetapi/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.includes("/static")) return route.continue();
        const segments = url.pathname.split("/").map(decodeURIComponent);
        let body;
        if (url.pathname.endsWith("/session"))
          body = { userId: "@manager:britstadt.test", type: "widget" };
        else if (url.pathname.endsWith("/config/sections"))
          body = { bridgeManagement: true };
        else if (url.pathname.endsWith("/rooms")) body = rooms;
        else if (url.pathname.endsWith("/accounts")) body = accounts;
        else if (url.pathname.endsWith("/chats")) body = chats[segments.at(-2)];
        else if (url.pathname.endsWith("/portals"))
          body = portals[segments.at(-2)];
        else if (url.pathname.endsWith("/operations"))
          body = operate(route.request().postDataJSON());
        else if (url.pathname.endsWith("/reconcile")) body = null;
        else if (url.pathname.endsWith("/connections")) body = [];
        else throw new Error(`Unexpected request: ${url.pathname}`);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.goto(`${origin}/demo?scheme=${scheme}`);
      const widget = page.frameLocator("#widget");
      await widget
        .getByRole("heading", { name: "In this room" })
        .waitFor({ timeout: 20000 });
      return { page, widget };
    }
    async function shot(page, name) {
      await page.screenshot({ path: path.join(output, name) });
    }
    async function overflow(page) {
      return page.evaluate(() => {
        const frame = document.getElementById("widget").contentWindow;
        return frame.document.documentElement.scrollWidth - frame.innerWidth;
      });
    }

    const light = await open("light", 640, 720);
    await light.widget.getByText("Strong match").first().waitFor();
    await shot(light.page, "01-room-overview.png");

    await light.widget.getByRole("button", { name: "Manage" }).click();
    await light.widget.getByLabel("Relay through").waitFor();
    await shot(light.page, "02-manage-relay.png");
    await light.widget.getByRole("button", { name: "Close" }).click();

    await light.widget
      .getByRole("button", { name: "Connect Britstadt Volunteers 🚒" })
      .click();
    await light.widget
      .getByText("Britstadt Volunteers 🚒 is connected with relay on.")
      .waitFor();
    assert.equal(portals.signal[0].room_id, rooms[0].id);
    assert.equal(portals.signal[0].relay, true);

    await light.widget
      .getByRole("button", { name: "Move Britstadt volunteer" })
      .click();
    await light.widget.getByRole("dialog").waitFor();
    await shot(light.page, "03-move-confirmation.png");
    await light.widget
      .getByRole("button", { name: "Move", exact: true })
      .click();
    await light.widget
      .getByText("Britstadt volunteer moved here with relay on.")
      .waitFor();
    assert.equal(portals.line[0].room_id, rooms[0].id);

    await light.widget.getByRole("button", { name: "All groups" }).click();
    await light.widget
      .getByRole("searchbox", { name: "Search groups" })
      .waitFor();
    await shot(light.page, "04-all-groups.png");
    assert.ok((await overflow(light.page)) <= 1);

    const dark = await open("dark", 640, 720);
    await dark.widget.getByText("Relay on").first().waitFor();
    await dark.widget.getByRole("button", { name: "Manage" }).first().click();
    await shot(dark.page, "05-dark.png");

    const narrow = await open("light", 380, 760);
    await narrow.widget.getByRole("button", { name: "All groups" }).click();
    await shot(narrow.page, "06-narrow.png");
    assert.ok(
      (await overflow(narrow.page)) <= 1,
      "Narrow view scrolls horizontally",
    );

    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ passed: true, operations }, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
