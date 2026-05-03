import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { monitorRunner } from "../services/monitorRunner";
import { notify, sendOneSms, fetchSmsStatus, type SmsResult } from "../services/notifier";

export const dashboardRouter = Router();

dashboardRouter.get("/", async (_req, res) => {
  const monitors = await prisma.monitor.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      keywords: true,
      checks: { orderBy: { checkedAt: "desc" }, take: 1 },
    },
  });
  res.render("monitors/index", { monitors });
});

dashboardRouter.get("/monitors/new", (_req, res) => {
  res.render("monitors/new");
});

dashboardRouter.post("/monitors", async (req, res) => {
  const { name, url, intervalSec, cookies, keywords } = req.body;

  const parsedCookies = parseCookies(cookies);
  const parsedKeywords = parseKeywords(keywords);

  const renderJs = req.body.renderJs === "on" || req.body.renderJs === "true";
  const markerKeyword =
    typeof req.body.markerKeyword === "string" && req.body.markerKeyword.trim()
      ? req.body.markerKeyword.trim()
      : null;

  const created = await prisma.monitor.create({
    data: {
      name: String(name).trim(),
      url: String(url).trim(),
      intervalSec: Math.max(5, Number(intervalSec) || 60),
      cookies: parsedCookies ?? Prisma.JsonNull,
      renderJs,
      markerKeyword,
      keywords: { create: parsedKeywords },
    },
  });

  await monitorRunner.upsert(created.id);
  res.redirect("/");
});

dashboardRouter.get("/monitors/:id", async (req, res) => {
  const monitor = await prisma.monitor.findUnique({
    where: { id: req.params.id },
    include: {
      keywords: true,
      checks: {
        orderBy: { checkedAt: "desc" },
        take: 50,
        include: { keywordResults: { include: { keyword: true } } },
      },
    },
  });
  if (!monitor) {
    res.status(404).send("Monitor not found");
    return;
  }
  res.render("monitors/show", { monitor });
});

dashboardRouter.get("/monitors/:id/edit", async (req, res) => {
  const monitor = await prisma.monitor.findUnique({
    where: { id: req.params.id },
    include: { keywords: true },
  });
  if (!monitor) {
    res.status(404).send("Monitor not found");
    return;
  }
  res.render("monitors/edit", { monitor });
});

dashboardRouter.post("/monitors/:id", async (req, res) => {
  const monitor = await prisma.monitor.findUnique({ where: { id: req.params.id } });
  if (!monitor) {
    res.status(404).send("Monitor not found");
    return;
  }

  const { name, url, intervalSec, cookies, keywords } = req.body;
  const parsedCookies = parseCookies(cookies);
  const parsedKeywords = parseKeywords(keywords);
  const renderJs = req.body.renderJs === "on" || req.body.renderJs === "true";
  const markerKeyword =
    typeof req.body.markerKeyword === "string" && req.body.markerKeyword.trim()
      ? req.body.markerKeyword.trim()
      : null;

  await prisma.$transaction([
    prisma.keyword.deleteMany({ where: { monitorId: monitor.id } }),
    prisma.monitor.update({
      where: { id: monitor.id },
      data: {
        name: String(name).trim(),
        url: String(url).trim(),
        intervalSec: Math.max(5, Number(intervalSec) || 60),
        cookies: parsedCookies ?? Prisma.JsonNull,
        renderJs,
        markerKeyword,
        keywords: { create: parsedKeywords },
      },
    }),
  ]);

  await monitorRunner.upsert(monitor.id);
  res.redirect(`/monitors/${monitor.id}`);
});

dashboardRouter.post("/monitors/:id/toggle", async (req, res) => {
  const monitor = await prisma.monitor.findUnique({ where: { id: req.params.id } });
  if (!monitor) {
    res.status(404).send("Monitor not found");
    return;
  }
  await prisma.monitor.update({
    where: { id: monitor.id },
    data: { isActive: !monitor.isActive },
  });
  await monitorRunner.upsert(monitor.id);
  res.redirect("/");
});

dashboardRouter.post("/monitors/:id/delete", async (req, res) => {
  await prisma.monitor.delete({ where: { id: req.params.id } });
  monitorRunner.remove(req.params.id);
  res.redirect("/");
});

const NOTIFICATION_CHANNELS = ["SMS", "CALL", "EMAIL", "WHATSAPP", "WEBHOOK"] as const;
type NotificationChannelFilter = (typeof NOTIFICATION_CHANNELS)[number];

dashboardRouter.get("/notifications", async (req, res) => {
  const raw = typeof req.query.channel === "string" ? req.query.channel.toUpperCase() : "";
  const channel: NotificationChannelFilter | null = (NOTIFICATION_CHANNELS as readonly string[]).includes(raw)
    ? (raw as NotificationChannelFilter)
    : null;

  const matches = await prisma.check.findMany({
    where: {
      status: "PASSING",
      notifications: channel ? { some: { channel } } : { some: {} },
    },
    orderBy: { checkedAt: "desc" },
    take: 100,
    include: {
      monitor: true,
      keywordResults: { include: { keyword: true } },
      notifications: {
        ...(channel ? { where: { channel } } : {}),
        orderBy: { createdAt: "asc" },
      },
    },
  });

  res.render("notifications/index", {
    matches,
    channel,
    channels: NOTIFICATION_CHANNELS,
  });
});

dashboardRouter.get("/test-sms", (_req, res) => {
  res.render("test-sms/form");
});

dashboardRouter.get("/test-send-all", (_req, res) => {
  res.render("test-send-all/form");
});

dashboardRouter.post("/test-send-all", async (req, res) => {
  const subject = (typeof req.body.subject === "string" && req.body.subject.trim()) || "[leet-checkin] debug fan-out";
  const text = (typeof req.body.text === "string" && req.body.text.trim()) ||
    `Triggered manually via /test-send-all at ${new Date().toISOString()}`;

  const startedAt = Date.now();
  const summary = await notify({ subject, text });
  res.render("test-send-all/results", {
    subject,
    text,
    summary,
    elapsedMs: Date.now() - startedAt,
  });
});

const MAX_BATCH = 100;
const STATUS_REFETCH_DELAY_MS = 4000;

dashboardRouter.post("/test-sms", async (req, res) => {
  const count = Math.min(MAX_BATCH, Math.max(1, Number(req.body.count) || 1));
  const message = String(req.body.message || "leet-checkin batch test").slice(0, 1000);

  const startedAt = Date.now();
  const initial: SmsResult[] = await Promise.all(
    Array.from({ length: count }, (_, i) => sendOneSms(`${message} (${i + 1}/${count})`)),
  );

  await new Promise((r) => setTimeout(r, STATUS_REFETCH_DELAY_MS));

  const refreshed: SmsResult[] = await Promise.all(
    initial.map(async (r) => (r.sid ? fetchSmsStatus(r.sid) : r)),
  );

  res.render("test-sms/results", {
    count,
    message,
    results: refreshed,
    elapsedMs: Date.now() - startedAt,
  });
});

function parseCookies(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "string" || !input.trim()) return null;
  const out: Record<string, string> = {};
  for (const pair of input.split(/[;\n]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

function parseKeywords(input: unknown): { value: string; mode: "PRESENT" | "MISSING" }[] {
  if (!input || typeof input !== "string") return [];
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("!")) return { value: line.slice(1).trim(), mode: "MISSING" as const };
      return { value: line, mode: "PRESENT" as const };
    })
    .filter((k) => k.value.length > 0);
}
