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

    let response;
    try {
      response = await fetchImpl(`${config.gatewayUrl}/tools/invoke`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          tool: config.messageTool,
          sessionKey: config.sessionKey,
          args: {
            action: "send",
            channel: config.channel,
            target,
            message: message.trim(),
            ...(accountId ? { accountId: accountId.trim() } : {}),
          },
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

    if (!response.ok) {
      const messageText =
        payload?.error?.message ?? payload?.message ?? `OpenClaw gateway returned ${response.status}`;
      const error = new Error(messageText);
      error.statusCode = response.status;
      error.details = payload;
      throw error;
    }

    return payload;
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
    gatewayCredential: env.OPENCLAW_GATEWAY_TOKEN ?? env.OPENCLAW_GATEWAY_PASSWORD,
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
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
