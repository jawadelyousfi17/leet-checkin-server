import { Resend } from "resend";
import twilio from "twilio";
import { getAllUsers } from "./usersClient";

export type NotificationPayload = {
  subject: string;
  text: string;
};

export type ChannelResult = {
  ok: boolean;
  status: string;
  details: Record<string, unknown>;
};

const twilioSid = process.env.TWILIO_ACCOUNT_SID;
const twilioToken = process.env.TWILIO_AUTH_TOKEN;
const twilioMessagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
const twilioFrom = process.env.TWILIO_FROM;
const twilioWhatsappFrom = process.env.TWILIO_WHATSAPP_FROM;
const notifyPhone = process.env.NOTIFY_PHONE;

// Voice-call worker pool: each worker owns one Twilio number and processes its
// assigned recipients sequentially, so we don't slam a single from-number with
// concurrent calls. Falls back to TWILIO_FROM if the pool var is empty.
const CALLER_POOL = ((process.env.TWILIO_CALL_FROM_POOL ?? twilioFrom ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean));
let callerCursor = 0;
function nextCaller(): string | null {
  if (CALLER_POOL.length === 0) return null;
  const n = CALLER_POOL[callerCursor % CALLER_POOL.length] ?? null;
  callerCursor++;
  return n;
}

const resendKey = process.env.RESEND_API_KEY;
const resendFrom = process.env.RESEND_FROM;

// Resend free tier caps at 5 req/s. Cap ourselves at 4/s by spacing call starts
// 250ms apart — each scheduled call reserves the next slot, regardless of how
// long the underlying API request takes.
const RESEND_MIN_INTERVAL_MS = 250;
let resendNextSlot = 0;
function scheduleResend<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slot = Math.max(now, resendNextSlot);
  resendNextSlot = slot + RESEND_MIN_INTERVAL_MS;
  const delay = slot - now;
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      fn().then(resolve, reject);
    }, delay);
  });
}

const twilioClient =
  twilioSid && twilioToken ? twilio(twilioSid, twilioToken) : null;
const resendClient = resendKey ? new Resend(resendKey) : null;

if (!twilioClient || !(twilioMessagingServiceSid || twilioFrom)) {
  console.warn("[notifier] SMS disabled — Twilio SID/token + (messaging-service SID or FROM) required");
}
if (!twilioClient || CALLER_POOL.length === 0) {
  console.warn("[notifier] Voice call disabled — set TWILIO_CALL_FROM_POOL (comma-separated numbers) or TWILIO_FROM");
} else {
  console.log(`[notifier] voice call worker pool: ${CALLER_POOL.length} number(s)`);
}
if (!twilioClient || !twilioWhatsappFrom) {
  console.warn("[notifier] WhatsApp disabled — TWILIO_WHATSAPP_FROM required");
}
if (!resendClient || !resendFrom) {
  console.warn("[notifier] Email disabled — RESEND_API_KEY + RESEND_FROM required");
}

export type NotifySummary = {
  users: number;
  dispatched: { sms: number; call: number; email: number; whatsapp: number; webhook: number };
  failed: number;
  results: { channel: string; recipient: string; result: ChannelResult }[];
  error?: string;
};

export async function notify(payload: NotificationPayload): Promise<NotifySummary> {
  let users;
  try {
    users = await getAllUsers();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[notifier] users fetch failed:", err);
    return emptySummary({ error: msg });
  }
  if (users.length === 0) {
    console.warn("[notifier] no users — skipping notification");
    return emptySummary();
  }

  type Task = { channel: string; recipient: string; promise: Promise<ChannelResult> };
  const nonCallTasks: Task[] = [];
  const callRecipients: string[] = [];
  const counts = { sms: 0, call: 0, email: 0, whatsapp: 0, webhook: 0 };
  const smsBody = `${payload.subject}\n${payload.text}`;

  for (const u of users) {
    if (u.smsEnabled && u.phoneNumber) {
      nonCallTasks.push({ channel: "sms", recipient: u.phoneNumber, promise: sendSmsTo(u.phoneNumber, smsBody) });
      counts.sms++;
    }
    if (u.callEnabled && u.phoneNumber) {
      callRecipients.push(u.phoneNumber);
      counts.call++;
    }
    if (u.emailEnabled && u.email) {
      nonCallTasks.push({ channel: "email", recipient: u.email, promise: sendEmailTo(u.email, payload.subject, payload.text) });
      counts.email++;
    }
    if (u.whatsappEnabled && u.whatsappNumber) {
      nonCallTasks.push({ channel: "whatsapp", recipient: u.whatsappNumber, promise: sendWhatsappTo(u.whatsappNumber, smsBody) });
      counts.whatsapp++;
    }
    if (u.webhookEnabled && u.webhookUrl) {
      nonCallTasks.push({
        channel: "webhook",
        recipient: u.webhookUrl,
        promise: sendWebhookTo(u.webhookUrl, {
          subject: payload.subject,
          text: payload.text,
          at: new Date().toISOString(),
        }),
      });
      counts.webhook++;
    }
  }

  console.log(
    `[notifier] dispatching to ${users.length} users — sms=${counts.sms} call=${counts.call} (across ${Math.min(CALLER_POOL.length, callRecipients.length)} workers) email=${counts.email} whatsapp=${counts.whatsapp} webhook=${counts.webhook}`,
  );

  const [nonCallSettled, callDispatched] = await Promise.all([
    Promise.all(nonCallTasks.map((t) => t.promise)),
    dispatchCalls(callRecipients, payload.subject),
  ]);

  const results: { channel: string; recipient: string; result: ChannelResult }[] = [
    ...nonCallTasks.map((t, i) => ({
      channel: t.channel,
      recipient: t.recipient,
      result:
        nonCallSettled[i] ??
        ({ ok: false, status: "error", details: { error: "missing result" } } as ChannelResult),
    })),
    ...callDispatched.map((c) => ({ channel: "call", recipient: c.recipient, result: c.result })),
  ];

  const failed = results.filter((r) => !r.result.ok).length;
  if (failed > 0) console.warn(`[notifier] ${failed}/${results.length} sends failed`);

  return { users: users.length, dispatched: counts, failed, results };
}

function emptySummary(extra: Partial<NotifySummary> = {}): NotifySummary {
  return {
    users: 0,
    dispatched: { sms: 0, call: 0, email: 0, whatsapp: 0, webhook: 0 },
    failed: 0,
    results: [],
    ...extra,
  };
}

export async function sendSmsTo(to: string, body: string): Promise<ChannelResult> {
  if (!twilioClient) return skipped("twilio not configured");
  const sender = twilioMessagingServiceSid
    ? { messagingServiceSid: twilioMessagingServiceSid }
    : twilioFrom
      ? { from: twilioFrom }
      : null;
  if (!sender) return skipped("no Twilio SMS sender configured");
  try {
    const msg = await twilioClient.messages.create({
      ...sender,
      to,
      body: body.slice(0, 1500),
    });
    return {
      ok: true,
      status: msg.status,
      details: {
        sid: msg.sid,
        to: msg.to,
        errorCode: msg.errorCode ?? null,
        errorMessage: msg.errorMessage ?? null,
      },
    };
  } catch (err) {
    return errorResult(err);
  }
}

export async function sendVoiceCallTo(
  to: string,
  message: string,
  from?: string,
): Promise<ChannelResult> {
  if (!twilioClient) return skipped("twilio not configured");
  const fromNumber = from ?? nextCaller();
  if (!fromNumber) return skipped("no caller pool configured (TWILIO_CALL_FROM_POOL or TWILIO_FROM)");
  const spoken = xmlEscape(message);
  const twiml = `<Response><Pause length="1"/><Say voice="alice">${spoken}.</Say><Pause length="1"/><Say voice="alice">${spoken}.</Say></Response>`;
  try {
    const call = await twilioClient.calls.create({ from: fromNumber, to, twiml });
    return {
      ok: true,
      status: call.status,
      details: { sid: call.sid, to: call.to, from: fromNumber },
    };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Distributes voice calls across the caller-number pool. Each pool number runs
 * its own worker that processes its assigned recipients sequentially — so we
 * never have two concurrent calls leaving the same Twilio number, which Twilio
 * limits per outbound number. With N numbers in the pool we get N concurrent
 * calls maximum, regardless of how many recipients there are.
 */
export async function dispatchCalls(
  recipients: string[],
  message: string,
): Promise<{ recipient: string; result: ChannelResult }[]> {
  if (recipients.length === 0) return [];
  if (CALLER_POOL.length === 0) {
    return recipients.map((r) => ({
      recipient: r,
      result: skipped("no caller pool configured (TWILIO_CALL_FROM_POOL or TWILIO_FROM)"),
    }));
  }

  const buckets: { recipient: string; index: number }[][] = Array.from(
    { length: CALLER_POOL.length },
    () => [],
  );
  recipients.forEach((recipient, index) => {
    const bucket = buckets[index % CALLER_POOL.length];
    if (bucket) bucket.push({ recipient, index });
  });

  type Slot = { recipient: string; index: number; result: ChannelResult };
  const workerPromises = buckets.map(async (bucket, workerIdx): Promise<Slot[]> => {
    const fromNumber = CALLER_POOL[workerIdx];
    if (!fromNumber) return [];
    const out: Slot[] = [];
    for (const { recipient, index } of bucket) {
      const result = await sendVoiceCallTo(recipient, message, fromNumber);
      out.push({ recipient, index, result });
    }
    return out;
  });

  const flat = (await Promise.all(workerPromises)).flat();
  flat.sort((a, b) => a.index - b.index);
  return flat.map(({ recipient, result }) => ({ recipient, result }));
}

export async function sendEmailTo(
  to: string,
  subject: string,
  text: string,
): Promise<ChannelResult> {
  if (!resendClient || !resendFrom) return skipped("resend not configured");
  try {
    const result = await scheduleResend(() =>
      resendClient.emails.send({ from: resendFrom, to, subject, text }),
    );
    if (result.error) {
      return { ok: false, status: "error", details: { error: result.error } };
    }
    return { ok: true, status: "queued", details: { id: result.data?.id ?? null } };
  } catch (err) {
    return errorResult(err);
  }
}

export async function sendWhatsappTo(to: string, body: string): Promise<ChannelResult> {
  if (!twilioClient || !twilioWhatsappFrom) return skipped("whatsapp not configured (need TWILIO_WHATSAPP_FROM)");
  try {
    const msg = await twilioClient.messages.create({
      from: `whatsapp:${twilioWhatsappFrom}`,
      to: `whatsapp:${to}`,
      body: body.slice(0, 1500),
    });
    return {
      ok: true,
      status: msg.status,
      details: {
        sid: msg.sid,
        to: msg.to,
        errorCode: msg.errorCode ?? null,
        errorMessage: msg.errorMessage ?? null,
      },
    };
  } catch (err) {
    return errorResult(err);
  }
}

export async function sendWebhookTo(url: string, payload: unknown): Promise<ChannelResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: String(res.status),
      details: {
        httpStatus: res.status,
        bodyPreview: text.slice(0, 1000),
      },
    };
  } catch (err) {
    return errorResult(err);
  }
}

function skipped(reason: string): ChannelResult {
  return { ok: false, status: "skipped", details: { reason } };
}

function errorResult(err: unknown): ChannelResult {
  return {
    ok: false,
    status: "error",
    details: { error: err instanceof Error ? err.message : String(err) },
  };
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

// === Helpers used by /test-sms batch route (single env recipient) ===

export type SmsResult = {
  sid: string | null;
  status: string;
  errorCode: number | null;
  errorMessage: string | null;
};

export async function sendOneSms(body: string): Promise<SmsResult> {
  if (!twilioClient || !notifyPhone) {
    return { sid: null, status: "skipped", errorCode: null, errorMessage: "twilio not configured or NOTIFY_PHONE unset" };
  }
  const result = await sendSmsTo(notifyPhone, body);
  if (!result.ok) {
    return {
      sid: null,
      status: result.status,
      errorCode: null,
      errorMessage: typeof result.details["error"] === "string" ? (result.details["error"] as string) : (result.details["reason"] as string ?? null),
    };
  }
  return {
    sid: (result.details["sid"] as string | null) ?? null,
    status: result.status,
    errorCode: (result.details["errorCode"] as number | null) ?? null,
    errorMessage: (result.details["errorMessage"] as string | null) ?? null,
  };
}

export async function fetchSmsStatus(sid: string): Promise<SmsResult> {
  if (!twilioClient) {
    return { sid, status: "unknown", errorCode: null, errorMessage: "twilio not configured" };
  }
  try {
    const m = await twilioClient.messages(sid).fetch();
    return {
      sid: m.sid,
      status: m.status,
      errorCode: typeof m.errorCode === "number" ? m.errorCode : null,
      errorMessage: m.errorMessage ?? null,
    };
  } catch (err) {
    return {
      sid,
      status: "unknown",
      errorCode: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
