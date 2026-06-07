import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createApp, normalizeWhatsAppTarget } from "./server.js";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("normalizes supported WhatsApp targets", () => {
  assert.equal(normalizeWhatsAppTarget(" whatsapp:+15551234567 "), "+15551234567");
  assert.equal(normalizeWhatsAppTarget("120363000000000000@g.us"), "120363000000000000@g.us");
  assert.equal(normalizeWhatsAppTarget("12345@newsletter"), "12345@newsletter");
  assert.equal(normalizeWhatsAppTarget("555-1234"), "");
});

test("health endpoint is available", async () => {
  const baseUrl = await listen(createApp());
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("send requires the wrapper token when configured", async () => {
  const baseUrl = await listen(createApp({ apiToken: "wrapper-secret" }));
  const response = await fetch(`${baseUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ number: "+15551234567", message: "hello" }),
  });
  assert.equal(response.status, 401);
});

test("send invokes the OpenClaw message tool", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, result: { messageId: "123" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const baseUrl = await listen(
    createApp({
      apiToken: "wrapper-secret",
      gatewayCredential: "gateway-secret",
      fetchImpl,
    }),
  );

  const response = await fetch(`${baseUrl}/send`, {
    method: "POST",
    headers: {
      Authorization: "Bearer wrapper-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number: "+15551234567", message: " hello " }),
  });

  assert.equal(response.status, 200);
  assert.equal(request.url, "http://127.0.0.1:18789/tools/invoke");
  assert.equal(request.options.headers.Authorization, "Bearer gateway-secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    tool: "message",
    sessionKey: "main",
    args: {
      action: "send",
      channel: "whatsapp",
      target: "+15551234567",
      message: "hello",
    },
  });
});

test("completed idempotency keys replay without sending twice", async () => {
  let sendCount = 0;
  const saved = new Map();
  const idempotencyStore = {
    get: async (key) => saved.get(key) ?? null,
    set: async (key, value) => saved.set(key, value),
  };
  const fetchImpl = async () => {
    sendCount += 1;
    return new Response(JSON.stringify({ messageId: "message-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const baseUrl = await listen(createApp({
    fetchImpl,
    idempotencyStore,
    requireIdempotency: true,
  }));
  const request = () => fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "booking-message-123",
    },
    body: JSON.stringify({ number: "+15551234567", message: "hello" }),
  });

  assert.equal((await request()).status, 200);
  const replay = await request();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotentReplay, true);
  assert.equal(sendCount, 1);
});
