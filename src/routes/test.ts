import { Router } from "express";
import {
  notify,
  sendSmsTo,
  sendVoiceCallTo,
  sendEmailTo,
  sendWhatsappTo,
  sendWebhookTo,
} from "../services/notifier";

export const testRouter = Router();

testRouter.post("/sms", async (req, res) => {
  const { to, message } = req.body ?? {};
  if (!isString(to) || !isString(message)) {
    res.status(400).json({ error: "body must be { to: string, message: string }" });
    return;
  }
  const result = await sendSmsTo(to, message);
  res.status(result.ok ? 200 : 502).json(result);
});

testRouter.post("/call", async (req, res) => {
  const { to, message } = req.body ?? {};
  if (!isString(to) || !isString(message)) {
    res.status(400).json({ error: "body must be { to: string, message: string }" });
    return;
  }
  const result = await sendVoiceCallTo(to, message);
  res.status(result.ok ? 200 : 502).json(result);
});

testRouter.post("/email", async (req, res) => {
  const { to, subject, text } = req.body ?? {};
  if (!isString(to) || !isString(subject) || !isString(text)) {
    res.status(400).json({ error: "body must be { to: string, subject: string, text: string }" });
    return;
  }
  const result = await sendEmailTo(to, subject, text);
  res.status(result.ok ? 200 : 502).json(result);
});

testRouter.post("/whatsapp", async (req, res) => {
  const { to, message } = req.body ?? {};
  if (!isString(to) || !isString(message)) {
    res.status(400).json({ error: "body must be { to: string, message: string }" });
    return;
  }
  const result = await sendWhatsappTo(to, message);
  res.status(result.ok ? 200 : 502).json(result);
});

testRouter.post("/notify-all", async (req, res) => {
  const subject = isString(req.body?.subject)
    ? req.body.subject
    : "[leet-checkin] debug fan-out";
  const text = isString(req.body?.text)
    ? req.body.text
    : `Triggered manually via /api/test/notify-all at ${new Date().toISOString()}`;

  const summary = await notify({ subject, text });
  const status = summary.error ? 502 : summary.failed > 0 ? 207 : 200;
  res.status(status).json(summary);
});

testRouter.post("/webhook", async (req, res) => {
  const { url, payload } = req.body ?? {};
  if (!isString(url)) {
    res.status(400).json({ error: "body must be { url: string, payload?: any }" });
    return;
  }
  const result = await sendWebhookTo(url, payload ?? {});
  res.status(result.ok ? 200 : 502).json(result);
});

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
