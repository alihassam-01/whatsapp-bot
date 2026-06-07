# OpenClaw WhatsApp Send API

A small local HTTP API that sends WhatsApp messages through an OpenClaw
Gateway.

## Requirements

- Node.js 20 or newer
- OpenClaw CLI
- A running OpenClaw Gateway
- The OpenClaw WhatsApp plugin enabled and linked by QR

WhatsApp uses WhatsApp Web/Baileys. You do not need a Meta developer app,
Twilio account, access token, phone-number ID, webhook secret, or business ID.

## OpenClaw setup

```powershell
openclaw plugins enable whatsapp
openclaw channels add --channel whatsapp
openclaw channels login --channel whatsapp
openclaw gateway run
```

The login command displays a QR code. On your phone, open WhatsApp, go to
**Settings > Linked devices > Link a device**, and scan it. A separate WhatsApp
number is recommended, but a personal number is supported.

## Environment

Copy `.env.example` values into your shell or deployment environment:

- `OPENCLAW_GATEWAY_URL`: defaults to `http://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN`: value configured at `gateway.auth.token`
- `OPENCLAW_GATEWAY_PASSWORD`: use instead when gateway auth mode is `password`
- `OPENCLAW_SESSION_KEY`: defaults to `main`
- `OPENCLAW_MESSAGE_TOOL`: defaults to `message`
- `OPENCLAW_CHANNEL`: defaults to `whatsapp`
- `OPENCLAW_TIMEOUT_MS`: defaults to `30000`
- `API_TOKEN`: optional bearer token protecting this wrapper's `/send` endpoint
- `REQUIRE_IDEMPOTENCY`: set to `true` in production
- `IDEMPOTENCY_STORE_PATH`: durable replay ledger path
- `PORT`: defaults to `3000`

Do not expose either the OpenClaw Gateway or this wrapper publicly without
authentication. The Gateway credential grants operator-level access.

## Run

```powershell
$env:OPENCLAW_GATEWAY_TOKEN = "your gateway token"
$env:API_TOKEN = "choose a separate wrapper token"
npm start
```

## Send a message

Use an E.164 number, including the country code and leading `+`:

```powershell
$headers = @{
  Authorization = "Bearer choose a separate wrapper token"
  "Content-Type" = "application/json"
}
$body = @{
  number = "+15551234567"
  message = "hello from OpenClaw"
} | ConvertTo-Json

Invoke-RestMethod http://127.0.0.1:3000/send `
  -Method Post -Headers $headers -Body $body
```

`accountId` is optional and only needed when multiple WhatsApp accounts are
configured.

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `POST /v1/messages` (preferred) or `POST /send`

Send an `Idempotency-Key` header for every transactional message. Repeating a
completed key returns the saved result without invoking WhatsApp again.
