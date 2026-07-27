import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  port: 3000,
  gatewayUrl: "http://127.0.0.1:18789",
  sessionKey: "main",
  messageTool: "message",
  channel: "whatsapp",
  timeoutMs: 30_000,
  idempotencyStorePath: "./data/idempotency.json",
};

export function createFileIdempotencyStore(filePath) {
  let loaded = false;
  let entries = {};

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      entries = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      entries = {};
    }
  }

  return {
    async get(key) {
      await load();
      return entries[key] ?? null;
    },
    async set(key, value) {
      await load();
      entries[key] = value;
      const keys = Object.keys(entries);
      if (keys.length > 10_000) {
        for (const oldKey of keys.slice(0, keys.length - 10_000)) {
          delete entries[oldKey];
        }
      }
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(entries), "utf8");
      await rename(temporaryPath, filePath);
    },
  };
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("Request body is too large");
        error.statusCode = 413;
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error("Request body must be valid JSON");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

export function normalizeWhatsAppTarget(input) {
  if (typeof input !== "string") {
    return "";
  }

  const target = input.trim().replace(/^whatsapp:/i, "");
  if (/^\+[1-9]\d{6,14}$/.test(target)) {
    return target;
  }
  if (/^[^@\s]+@(g\.us|newsletter)$/.test(target)) {
    return target;
  }
  return "";
}

function isAuthorized(req, apiToken) {
  if (!apiToken) {
    return true;
  }
  const provided = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${apiToken}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createApp(options = {}) {
  const config = {
    port: options.port ?? DEFAULTS.port,
    gatewayUrl: (options.gatewayUrl ?? DEFAULTS.gatewayUrl).replace(/\/$/, ""),
    gatewayCredential: options.gatewayCredential,
    sessionKey: options.sessionKey ?? DEFAULTS.sessionKey,
    messageTool: options.messageTool ?? DEFAULTS.messageTool,
    channel: options.channel ?? DEFAULTS.channel,
    apiToken: options.apiToken,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    requireIdempotency: options.requireIdempotency ?? false,
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const idempotencyStore = options.idempotencyStore
    ?? createFileIdempotencyStore(options.idempotencyStorePath ?? DEFAULTS.idempotencyStorePath);
  const inFlight = new Map();

  async function invokeOpenClawMessageTool({ number, message, accountId }) {
    const target = normalizeWhatsAppTarget(number);
    if (!target) {
      const error = new Error(
        "number must be an E.164 phone number such as +15551234567, a group JID, or a newsletter JID",
      );
      error.statusCode = 400;
      throw error;
    }

    if (typeof message !== "string" || !message.trim()) {
      const error = new Error("message is required");
      error.statusCode = 400;
      throw error;
    }

    if (accountId !== undefined && (typeof accountId !== "string" || !accountId.trim())) {
      const error = new Error("accountId must be a non-empty string");
      error.statusCode = 400;
      throw error;
    }

    const headers = { "Content-Type": "application/json" };
    if (config.gatewayCredential) {
      headers.Authorization = `Bearer ${config.gatewayCredential}`;
    }

    const attempts = [
      {
        tool: config.messageTool,
        args: {
          action: "send",
          channel: config.channel,
          target,
          message: message.trim(),
          ...(accountId ? { accountId: accountId.trim() } : {}),
        },
      },
      {
        tool: config.messageTool === "message" ? "message.send" : config.messageTool,
        args: {
          channel: config.channel,
          target,
          message: message.trim(),
          ...(accountId ? { account: accountId.trim() } : {}),
        },
      },
    ];

    let lastError;
    for (const attempt of attempts) {
      let response;
      try {
        response = await fetchImpl(`${config.gatewayUrl}/tools/invoke`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(config.timeoutMs),
          body: JSON.stringify({
            tool: attempt.tool,
            sessionKey: config.sessionKey,
            args: attempt.args,
          }),
        });
      } catch (cause) {
        const error = new Error(
          cause?.name === "TimeoutError"
            ? "OpenClaw gateway request timed out"
            : "OpenClaw gateway is unavailable",
        );
        error.statusCode = cause?.name === "TimeoutError" ? 504 : 502;
        throw error;
      }

      const rawText = await response.text();
      let payload;
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = { raw: rawText };
      }

      if (response.ok) {
        return payload;
      }

      const messageText =
        payload?.error?.message ?? payload?.message ?? `OpenClaw gateway returned ${response.status}`;
      const error = new Error(messageText);
      error.statusCode = response.status;
      error.details = payload;
      lastError = error;

      const shouldRetryWithFallback = attempt.tool === "message"
        && attempts.length > 1
        && /tool not available: message/i.test(messageText);
      if (!shouldRetryWithFallback) {
        throw error;
      }
    }

    throw lastError ?? new Error("OpenClaw message send failed");
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
        sendJson(res, 200, {
          ok: true,
          service: "openclaw-whatsapp-send-api",
          gatewayUrl: config.gatewayUrl,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        const headers = {};
        if (config.gatewayCredential) {
          headers.Authorization = `Bearer ${config.gatewayCredential}`;
        }
        try {
          await fetchImpl(`${config.gatewayUrl}/healthz`, {
            headers,
            signal: AbortSignal.timeout(Math.min(config.timeoutMs, 5_000)),
          });
          sendJson(res, 200, { ok: true, gatewayReachable: true });
        } catch {
          sendJson(res, 503, { ok: false, gatewayReachable: false });
        }
        return;
      }

      if (req.method === "POST" && (url.pathname === "/send" || url.pathname === "/v1/messages")) {
        if (!isAuthorized(req, config.apiToken)) {
          sendJson(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }

        const body = await readJsonBody(req);
        const idempotencyKey = String(
          req.headers["idempotency-key"] ?? body.idempotencyKey ?? "",
        ).trim();
        if (idempotencyKey && !/^[A-Za-z0-9:_-]{8,255}$/.test(idempotencyKey)) {
          sendJson(res, 400, { ok: false, error: "Invalid idempotency key" });
          return;
        }
        if (config.requireIdempotency && !idempotencyKey) {
          sendJson(res, 400, { ok: false, error: "Idempotency-Key is required" });
          return;
        }

        if (idempotencyKey) {
          const saved = await idempotencyStore.get(idempotencyKey);
          if (saved) {
            sendJson(res, 200, { ok: true, result: saved, idempotentReplay: true });
            return;
          }
        }

        const send = async () => {
          const result = await invokeOpenClawMessageTool(body);
          if (idempotencyKey) {
            await idempotencyStore.set(idempotencyKey, result);
          }
          return result;
        };
        const promise = idempotencyKey
          ? inFlight.get(idempotencyKey) ?? send()
          : send();
        if (idempotencyKey && !inFlight.has(idempotencyKey)) {
          inFlight.set(idempotencyKey, promise);
        }
        try {
          const result = await promise;
          sendJson(res, 200, { ok: true, result });
        } finally {
          if (idempotencyKey) inFlight.delete(idempotencyKey);
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(res, statusCode, {
        ok: false,
        error: error?.message ?? "Unexpected error",
        ...(error?.details ? { details: error.details } : {}),
      });
    }
  });
}

export function startServer(env = process.env) {
  if (env.NODE_ENV === "production" && !env.API_TOKEN) {
    throw new Error("API_TOKEN is required in production");
  }
  const server = createApp({
    port: Number.parseInt(env.PORT ?? String(DEFAULTS.port), 10),
    gatewayUrl: env.OPENCLAW_GATEWAY_URL ?? DEFAULTS.gatewayUrl,
    gatewayCredential: env.OPENCLAW_GATEWAY_TOKEN ?? env.OPENCLAW_GATEWAY_PASSWORD ?? "dev-secret-token",
    sessionKey: env.OPENCLAW_SESSION_KEY ?? DEFAULTS.sessionKey,
    messageTool: env.OPENCLAW_MESSAGE_TOOL ?? DEFAULTS.messageTool,
    channel: env.OPENCLAW_CHANNEL ?? DEFAULTS.channel,
    apiToken: env.API_TOKEN,
    timeoutMs: Number.parseInt(env.OPENCLAW_TIMEOUT_MS ?? String(DEFAULTS.timeoutMs), 10),
    requireIdempotency: env.NODE_ENV === "production"
      ? env.REQUIRE_IDEMPOTENCY !== "false"
      : env.REQUIRE_IDEMPOTENCY === "true",
    idempotencyStorePath: env.IDEMPOTENCY_STORE_PATH ?? DEFAULTS.idempotencyStorePath,
  });
  const port = Number.parseInt(env.PORT ?? String(DEFAULTS.port), 10);

  server.listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });

  // Mock OpenAI server to intercept inbound messages from OpenClaw
  const mockServer = http.createServer(async (req, res) => {
    console.log(`[Mock OpenAI] Received request: ${req.method} ${req.url}`);
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        let sender = "+10000000000";
        let messageId = null;

        // Extract user text properly from OpenClaw input array or messages array
        let messagesArray = [];
        if (Array.isArray(body.input)) {
          messagesArray = body.input;
        } else if (Array.isArray(body.messages)) {
          messagesArray = body.messages;
        }
        
        await writeFile('payload.json', JSON.stringify(messagesArray, null, 2));

        let rawText = "";
        const userMessages = messagesArray.filter((m) => m.role === "user");
        for (const m of userMessages) {
          let t = "";
          if (Array.isArray(m.content)) {
            t = m.content.map((c) => c.text || "").join("\n");
          } else if (typeof m.content === "string") {
            t = m.content;
          }
          
          if (t && t.includes("BEGIN_OPENCLAW_INTERNAL_CONTEXT")) {
            // Extract sender and message_id from the internal context block
            const senderMatch = t.match(/"e164"\s*:\s*"(\+\d+)"/);
            if (senderMatch) {
              sender = senderMatch[1];
            }
            const msgIdMatch = t.match(/"message_id"\s*:\s*"([^"]+)"/);
            if (msgIdMatch) {
              messageId = msgIdMatch[1];
            }
          } else if (t) {
            // This is the actual user message
            rawText = t;
          }
        }
        
        if (!rawText) {
          rawText = JSON.stringify(body);
        }

        console.log("[Mock OpenAI] Extracted raw text:", rawText);

        let text = rawText;

        // Clean up any remaining OpenClaw context prefixes if they exist
        text = text.replace(/\[.*?\]/g, "").trim();

        let dedupeKey = messageId || rawText;

        // Deduplicate based on dedupeKey to prevent double processing if OpenClaw retries
        if (dedupeKey && global.seenMessages && global.seenMessages.has(dedupeKey)) {
          console.log("[Mock OpenAI] Ignoring duplicate request");
        } else {
          if (dedupeKey) {
            global.seenMessages = global.seenMessages || new Set();
            global.seenMessages.add(dedupeKey);
            
            // Auto-expire from seen set after 10 seconds to allow the user to send identical messages later
            setTimeout(() => {
              global.seenMessages.delete(dedupeKey);
            }, 10000);
          }

          try {
            // Use native fetch
          await fetch("http://127.0.0.1:3008/api/whatsapp-inbound/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "message_received",
              data: {
                channel: "whatsapp",
                number: sender,
                text: text
              }
            })
          });
          } catch (e) {
            console.error("[Mock OpenAI] Failed to forward to webhook:", e.message);
          }
        } // end of else block for deduplication
        
        // Return a generic success response that satisfies both chat/completions and /responses
        sendJson(res, 200, {
          id: "mock-123",
          object: req.url.includes("responses") ? "response" : "chat.completion",
          created: Date.now(),
          model: body.model || "gpt-5.5",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "stop"
          }]
        });
      } catch (e) {
        console.error(e);
        sendJson(res, 500, { error: e.message });
      }
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  });
  
  mockServer.listen(3009, "127.0.0.1", () => {
    console.log("Mock OpenAI Server listening on http://127.0.0.1:3009");
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
