# leet-checkin-server

Express + TypeScript service that polls configured URLs on an interval, watches for keyword conditions in the response body, and fires multi-channel notifications when a match is found. On match it auto-pauses the monitor (one-shot watch).

Notification recipients are pulled live from `${HOST_API}/api/all-users` on every dispatch — there is no local user table.

## Getting started

```bash
npm install
cp .env.example .env   # if you have one — otherwise edit .env directly
npx prisma migrate dev
npm run dev
```

Dashboard at `http://localhost:8080/`.

## Notification test endpoints

Unauthenticated `POST` routes that send a single notification through one channel. Useful for verifying provider credentials and end-to-end deliverability without waiting for a monitor to match.

> **No bearer token is required.** These routes are intended to be reachable only over a trusted network (localhost, VPN, internal LB). Do not expose them publicly.

All routes accept `application/json` and respond with JSON of shape:

```json
{
  "ok": true,
  "status": "<provider-status-string>",
  "details": { /* provider-specific fields */ }
}
```

`ok` is `true` only when the provider accepted the request without error. Use HTTP status to branch (`200` on success, `400` on bad input, `502` when the provider rejected or wasn't configured).

### `POST /api/test/sms`

Sends one SMS via Twilio. Uses `TWILIO_MESSAGING_SERVICE_SID` (preferred) or `TWILIO_FROM` as the sender.

**Body:**

```json
{ "to": "+15551234567", "message": "hello from leet-checkin" }
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/test/sms \
  -H "content-type: application/json" \
  -d '{"to":"+15551234567","message":"test"}'
```

**Response (success):**

```json
{
  "ok": true,
  "status": "queued",
  "details": {
    "sid": "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "to": "+15551234567",
    "errorCode": null,
    "errorMessage": null
  }
}
```

### `POST /api/test/call`

Triggers a Twilio voice call to `to`. The call plays a short TTS announcement of `message` (spoken twice with pauses). Voice requires `TWILIO_FROM` — Messaging Service SIDs do **not** work for calls.

**Body:**

```json
{ "to": "+15551234567", "message": "the watcher matched" }
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/test/call \
  -H "content-type: application/json" \
  -d '{"to":"+15551234567","message":"hello"}'
```

**Response (success):**

```json
{ "ok": true, "status": "queued", "details": { "sid": "CAxxxxxxxx…", "to": "+15551234567" } }
```

### `POST /api/test/email`

Sends one email via Resend.

**Body:**

```json
{ "to": "you@example.com", "subject": "subject line", "text": "plaintext body" }
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/test/email \
  -H "content-type: application/json" \
  -d '{"to":"you@example.com","subject":"hello","text":"test"}'
```

**Response (success):**

```json
{ "ok": true, "status": "queued", "details": { "id": "e20a798c-…" } }
```

### `POST /api/test/whatsapp`

Sends one WhatsApp message via Twilio. Requires `TWILIO_WHATSAPP_FROM` to be set to a Twilio WhatsApp-enabled number (e.g. `+14155238886` for the sandbox; do **not** include the `whatsapp:` prefix in the env value — the code adds it).

**Body:**

```json
{ "to": "+15551234567", "message": "hi from whatsapp" }
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/test/whatsapp \
  -H "content-type: application/json" \
  -d '{"to":"+15551234567","message":"hi"}'
```

**Response (success):**

```json
{ "ok": true, "status": "queued", "details": { "sid": "SMxxxx…", "to": "whatsapp:+15551234567", "errorCode": null, "errorMessage": null } }
```

### `POST /api/test/notify-all`

Runs the *exact* live notification flow on demand: fetches the current user list from `${HOST_API}/api/all-users`, then dispatches the configured `subject`/`text` to every channel each user has enabled (SMS, voice, email, WhatsApp, webhook). Same code path the monitor runner uses on a match.

`subject` and `text` are optional; defaults are filled in if omitted (handy for `curl -X POST` with no body).

**Body:**

```json
{ "subject": "ping", "text": "manual fan-out test" }
```

**Example (no body):**

```bash
curl -X POST http://localhost:8080/api/test/notify-all
```

**Response (success):**

```json
{
  "users": 1,
  "dispatched": { "sms": 1, "call": 0, "email": 1, "whatsapp": 0, "webhook": 0 },
  "failed": 0,
  "results": [
    { "channel": "sms",   "recipient": "+212…", "result": { "ok": true, "status": "queued", "details": { "sid": "SM…", … } } },
    { "channel": "email", "recipient": "you@…",  "result": { "ok": true, "status": "queued", "details": { "id": "…" } } }
  ]
}
```

**Status codes:**

- `200` — every send succeeded.
- `207` (Multi-Status) — at least one channel failed; check `failed` count and `results[].result.ok` per row.
- `502` — couldn't even reach the users API (`error` field on the summary explains why).

### `POST /api/test/webhook`

Performs an HTTP `POST` of `payload` (as JSON) to the supplied `url`. Returns the upstream HTTP status and a body preview (truncated to 1000 chars).

**Body:**

```json
{ "url": "https://example.com/hooks/leet", "payload": { "event": "test", "data": 123 } }
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/test/webhook \
  -H "content-type: application/json" \
  -d '{"url":"https://webhook.site/<id>","payload":{"hello":"world"}}'
```

**Response (success):**

```json
{
  "ok": true,
  "status": "200",
  "details": { "httpStatus": 200, "bodyPreview": "OK" }
}
```

`ok` is `true` only when the upstream responded with a 2xx; a 4xx/5xx returns `ok: false` and HTTP `502` from this route.

### Error responses

| HTTP | Body                                                  | When                                                   |
| ---- | ----------------------------------------------------- | ------------------------------------------------------ |
| 400  | `{ "error": "body must be { … }" }`                   | Required fields missing or wrong type                  |
| 502  | `{ "ok": false, "status": "skipped", "details": { "reason": "…" } }` | Provider not configured (missing env vars)             |
| 502  | `{ "ok": false, "status": "error", "details": { "error": "…" } }`    | Provider call threw (auth, network, invalid recipient) |
