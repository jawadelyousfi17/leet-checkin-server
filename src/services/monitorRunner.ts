import { Prisma, type Keyword, type Monitor } from "@prisma/client";
import { prisma } from "../db";
import { notify, sendEmailTo, type NotifySummary } from "./notifier";
import { getBrowser } from "./browser";

type CachedMonitor = Monitor & { keywords: Keyword[] };

type CheckOutcome = {
  status: "PASSING" | "FAILING" | "ERROR";
  httpStatus: number | null;
  durationMs: number;
  errorMessage: string | null;
  keywordResults: { keywordId: string; matched: boolean }[];
  markerMissing: boolean;
};

class MonitorRunner {
  private cache = new Map<string, CachedMonitor>();
  private timers = new Map<string, NodeJS.Timeout>();
  private markerOk = new Map<string, boolean>();
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const monitors = await prisma.monitor.findMany({ include: { keywords: true } });
    for (const m of monitors) {
      this.cache.set(m.id, m);
      if (m.isActive) this.schedule(m.id);
    }
    console.log(`[monitor-runner] loaded ${monitors.length} monitors (${this.timers.size} active)`);
  }

  async upsert(id: string): Promise<void> {
    const m = await prisma.monitor.findUnique({
      where: { id },
      include: { keywords: true },
    });
    if (!m) {
      this.remove(id);
      return;
    }
    this.cache.set(m.id, m);
    this.cancelTimer(m.id);
    if (m.isActive) this.schedule(m.id);
  }

  remove(id: string): void {
    this.cancelTimer(id);
    this.cache.delete(id);
    this.markerOk.delete(id);
  }

  list(): CachedMonitor[] {
    return [...this.cache.values()];
  }

  private schedule(id: string): void {
    const m = this.cache.get(id);
    if (!m) return;
    const timer = setTimeout(() => {
      void this.tick(id);
    }, m.intervalSec * 1000);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private cancelTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private async tick(id: string): Promise<void> {
    const m = this.cache.get(id);
    if (!m || !m.isActive) return;

    const outcome = await runCheck(m);

    let createdCheck;
    try {
      createdCheck = await prisma.check.create({
        data: {
          monitorId: m.id,
          status: outcome.status,
          httpStatus: outcome.httpStatus,
          durationMs: outcome.durationMs,
          errorMessage: outcome.errorMessage,
          keywordResults: { create: outcome.keywordResults },
        },
      });
    } catch (err) {
      console.error(`[monitor-runner] failed to persist check for ${m.id}:`, err);
    }

    // Marker-keyword transition: only email on the OK -> MISSING edge so we
    // don't flood the inbox if the page stays broken across many checks.
    if (m.markerKeyword) {
      const previouslyOk = this.markerOk.get(id) ?? true;
      const currentlyOk = !outcome.markerMissing;
      if (previouslyOk && !currentlyOk) {
        void emailMarkerIssue(m, outcome);
      }
      this.markerOk.set(id, currentlyOk);
    }

    if (outcome.markerMissing) {
      // Skip the match flow entirely — we're not on the right page, so there's
      // nothing meaningful to evaluate. Reschedule and try again next interval.
      const stillCached = this.cache.get(id);
      if (stillCached?.isActive) this.schedule(id);
      return;
    }

    if (outcome.status === "PASSING") {
      let summary;
      try {
        summary = await notifyMatch(m, outcome);
      } catch (err) {
        console.error(`[monitor-runner] notify failed for ${m.id}:`, err);
      }

      if (createdCheck && summary && summary.results.length > 0) {
        try {
          await prisma.notification.createMany({
            data: summary.results.map((row) => ({
              checkId: createdCheck.id,
              monitorId: m.id,
              channel: row.channel.toUpperCase() as
                | "SMS"
                | "CALL"
                | "EMAIL"
                | "WHATSAPP"
                | "WEBHOOK",
              recipient: row.recipient,
              ok: row.result.ok,
              providerStatus: row.result.status,
              details: row.result.details as Prisma.InputJsonValue,
            })),
          });
        } catch (err) {
          console.error(`[monitor-runner] failed to persist notifications for ${m.id}:`, err);
        }
      }

      try {
        await prisma.monitor.update({
          where: { id: m.id },
          data: { isActive: false },
        });
      } catch (err) {
        console.error(`[monitor-runner] failed to pause ${m.id}:`, err);
      }
      const cached = this.cache.get(id);
      if (cached) cached.isActive = false;
      this.cancelTimer(id);
      console.log(`[monitor-runner] ${m.name} matched — paused`);
      return;
    }

    const stillCached = this.cache.get(id);
    if (stillCached?.isActive) this.schedule(id);
  }
}

async function runCheck(m: CachedMonitor): Promise<CheckOutcome> {
  const startedAt = Date.now();
  try {
    const fetched = m.renderJs ? await fetchWithBrowser(m) : await fetchPlain(m);
    const durationMs = Date.now() - startedAt;

    // Marker keyword sanity check — verify we're on the right page before
    // even looking at the real keyword rules.
    if (m.markerKeyword && !fetched.body.includes(m.markerKeyword)) {
      return {
        status: "ERROR",
        httpStatus: fetched.httpStatus,
        durationMs,
        errorMessage: `Marker keyword "${m.markerKeyword}" not found in response — wrong page, redirect, login wall, or render failure`,
        keywordResults: [],
        markerMissing: true,
      };
    }

    const keywordResults = m.keywords.map((k) => {
      const found = fetched.body.includes(k.value);
      const matched = k.mode === "PRESENT" ? found : !found;
      return { keywordId: k.id, matched };
    });

    const httpOk = fetched.httpStatus >= 200 && fetched.httpStatus < 400;
    const keywordsOk =
      keywordResults.length === 0 || keywordResults.some((r) => r.matched);

    return {
      status: httpOk && keywordsOk ? "PASSING" : "FAILING",
      httpStatus: fetched.httpStatus,
      durationMs,
      errorMessage: null,
      keywordResults,
      markerMissing: false,
    };
  } catch (err) {
    return {
      status: "ERROR",
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
      keywordResults: [],
      markerMissing: false,
    };
  }
}

type FetchResult = { body: string; httpStatus: number };

async function fetchPlain(m: CachedMonitor): Promise<FetchResult> {
  const headers: Record<string, string> = {};
  const cookieHeader = buildCookieHeader(m.cookies);
  if (cookieHeader) headers["cookie"] = cookieHeader;
  const res = await fetch(m.url, { headers, redirect: "follow" });
  return { body: await res.text(), httpStatus: res.status };
}

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

async function fetchWithBrowser(m: CachedMonitor): Promise<FetchResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: REALISTIC_UA,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "Africa/Casablanca",
    extraHTTPHeaders: {
      "accept-language": "en-US,en;q=0.9,fr;q=0.8",
    },
  });
  try {
    const cookieEntries = parseCookieEntries(m.cookies);
    if (cookieEntries.length > 0) {
      const target = new URL(m.url);
      const isHttps = target.protocol === "https:";
      await context.addCookies(
        cookieEntries.map(([name, value]) => ({
          name,
          value,
          domain: target.hostname,
          path: "/",
          secure: isHttps || name.startsWith("__Secure-"),
        })),
      );
    }
    const page = await context.newPage();
    const response = await page.goto(m.url, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 3_000 })
      .catch(() => undefined);
    const httpStatus = response?.status() ?? 0;
    const body = await page.content();

    console.log(
      `[browser] ${m.name} url=${m.url} status=${httpStatus} bytes=${body.length}`,
    );
    return { body, httpStatus };
  } finally {
    await context.close().catch(() => undefined);
  }
}

function parseCookieEntries(cookies: Monitor["cookies"]): [string, string][] {
  if (!cookies || typeof cookies !== "object" || Array.isArray(cookies)) return [];
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(cookies)) {
    if (typeof value !== "string" || !name) continue;
    out.push([name, value]);
  }
  return out;
}

async function notifyMatch(m: CachedMonitor, outcome: CheckOutcome): Promise<NotifySummary> {
  const subject = `[leet-checkin] ${m.name} — match found`;

  const matchedKeywords = outcome.keywordResults
    .filter((r) => r.matched)
    .map((r) => m.keywords.find((k) => k.id === r.keywordId))
    .filter((k): k is NonNullable<typeof k> => Boolean(k));

  const lines: string[] = [`${m.name} matched at ${m.url}`];
  if (outcome.httpStatus != null) lines.push(`HTTP ${outcome.httpStatus}`);
  if (matchedKeywords.length > 0) {
    lines.push(
      "Matched: " +
        matchedKeywords.map((k) => `${k.mode === "MISSING" ? "!" : ""}${k.value}`).join(", "),
    );
  }
  lines.push("(monitor paused)");

  return notify({ subject, text: lines.join("\n") });
}

async function emailMarkerIssue(m: CachedMonitor, outcome: CheckOutcome): Promise<void> {
  const notifyEmail = process.env.NOTIFY_EMAIL;
  if (!notifyEmail) {
    console.warn(`[monitor-runner] marker missing for ${m.name} but NOTIFY_EMAIL not set — cannot email`);
    return;
  }
  const subject = `[leet-checkin] ${m.name} — marker keyword missing`;
  const text = [
    `The watcher "${m.name}" failed its marker-keyword sanity check.`,
    "",
    `URL: ${m.url}`,
    `Marker expected: "${m.markerKeyword}"`,
    `HTTP status: ${outcome.httpStatus ?? "(none)"}`,
    "",
    "Likely causes:",
    "- Page is showing a redirect, login wall, or Cloudflare interstitial.",
    "- The site changed and the marker no longer matches.",
    "- A network or render failure prevented the right content from loading.",
    "",
    "The watcher is still running. Fix the marker or the page state.",
  ].join("\n");

  try {
    const result = await sendEmailTo(notifyEmail, subject, text);
    if (!result.ok) {
      console.error(`[monitor-runner] marker-issue email rejected:`, result);
    } else {
      console.log(`[monitor-runner] marker-issue email sent to ${notifyEmail} for ${m.name}`);
    }
  } catch (err) {
    console.error(`[monitor-runner] marker-issue email failed:`, err);
  }
}

function buildCookieHeader(cookies: Monitor["cookies"]): string | null {
  if (!cookies || typeof cookies !== "object" || Array.isArray(cookies)) return null;
  const parts: string[] = [];
  for (const [name, value] of Object.entries(cookies)) {
    if (typeof value !== "string" || !name) continue;
    parts.push(`${name}=${value}`);
  }
  return parts.length ? parts.join("; ") : null;
}

export const monitorRunner = new MonitorRunner();
