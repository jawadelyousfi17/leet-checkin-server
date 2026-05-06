import fs from "fs/promises";
import path from "path";
import { Prisma, type Keyword, type Monitor } from "@prisma/client";
import { prisma } from "../db";
import { notify, sendEmailTo, type NotifySummary } from "./notifier";
import { getBrowser } from "./browser";
import { refreshLoginCookies, shouldAttemptRefresh } from "./cookieRefresher";

const MONITOR_DEBUG_DIR = process.env.MONITOR_DEBUG_DIR || "./debug-monitor";

type CachedMonitor = Monitor & { keywords: Keyword[] };

type CheckOutcome = {
  status: "PASSING" | "FAILING" | "ERROR";
  httpStatus: number | null;
  durationMs: number;
  errorMessage: string | null;
  keywordResults: { keywordId: string; matched: boolean }[];
  markerMissing: boolean;
  // Forensic capture from the browser fetch — present only for renderJs
  // monitors and only carried along so tick() can dump it to disk on
  // FAILING/ERROR outcomes. Never persisted to the DB.
  debug?: {
    screenshot?: Buffer | undefined;
    body?: string | undefined;
  };
};

class MonitorRunner {
  private cache = new Map<string, CachedMonitor>();
  private timers = new Map<string, NodeJS.Timeout>();
  private markerOk = new Map<string, boolean>();
  private lastRefreshAt = new Map<string, number>();
  private refreshing = new Set<string>();
  private static readonly REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
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
    this.lastRefreshAt.delete(id);
    this.refreshing.delete(id);
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

  private async maybeRefreshCookies(m: CachedMonitor): Promise<void> {
    if (this.refreshing.has(m.id)) return;
    if (!shouldAttemptRefresh(m.url)) return;

    const now = Date.now();
    const last = this.lastRefreshAt.get(m.id) ?? 0;
    if (now - last < MonitorRunner.REFRESH_COOLDOWN_MS) {
      const waitSec = Math.ceil((MonitorRunner.REFRESH_COOLDOWN_MS - (now - last)) / 1000);
      console.log(
        `[monitor-runner] ${m.name}: marker missing — skip relogin (cooldown ${waitSec}s left)`,
      );
      return;
    }

    this.refreshing.add(m.id);
    this.lastRefreshAt.set(m.id, now);
    console.log(`[monitor-runner] ${m.name}: marker missing — attempting relogin`);
    try {
      const result = await refreshLoginCookies();
      if (!result.ok) {
        console.warn(`[monitor-runner] ${m.name}: relogin failed — ${result.error}`);
        return;
      }
      await prisma.monitor.update({
        where: { id: m.id },
        data: { cookies: result.cookies as Prisma.InputJsonValue },
      });
      const cached = this.cache.get(m.id);
      if (cached) {
        cached.cookies = result.cookies as Monitor["cookies"];
      }
      console.log(
        `[monitor-runner] ${m.name}: cookies refreshed (${Object.keys(result.cookies).length} cookies, finalUrl=${result.finalUrl})`,
      );
    } catch (err) {
      console.error(`[monitor-runner] ${m.name}: relogin threw:`, err);
    } finally {
      this.refreshing.delete(m.id);
    }
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

    if (outcome.status !== "PASSING") {
      await dumpCheckDebug(m, outcome);
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
      await this.maybeRefreshCookies(m);
      // Skip the match flow entirely — we're not on the right page, so there's
      // nothing meaningful to evaluate. Reschedule and try again next interval.
      const stillCached = this.cache.get(id);
      if (stillCached?.isActive) this.schedule(id);
      return;
    }

    if (outcome.status === "PASSING") {
      const trigger = outcome.keywordResults.some((r) => r.matched) ? "keyword" : "legacy";
      console.log(`[monitor-runner] ${m.name}: PASSING (trigger=${trigger}) — notifying + pausing`);
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

    const bodyLower = fetched.body.toLowerCase();

    // Marker keyword sanity check — verify we're on the right page before
    // even looking at the real keyword rules.
    if (m.markerKeyword && !bodyLower.includes(m.markerKeyword.toLowerCase())) {
      console.error(
        `[monitor-runner] ${m.name}: ERROR marker-missing httpStatus=${fetched.httpStatus} bodyBytes=${fetched.body.length} marker="${m.markerKeyword}"`,
      );
      return {
        status: "ERROR",
        httpStatus: fetched.httpStatus,
        durationMs,
        errorMessage: `Marker keyword "${m.markerKeyword}" not found in response — wrong page, redirect, login wall, or render failure`,
        keywordResults: [],
        markerMissing: true,
        debug: { screenshot: fetched.screenshot, body: fetched.body },
      };
    }

    const keywordResults = m.keywords.map((k) => {
      const found = bodyLower.includes(k.value.toLowerCase());
      const matched = k.mode === "PRESENT" ? found : !found;
      return { keywordId: k.id, matched };
    });

    const httpOk = fetched.httpStatus >= 200 && fetched.httpStatus < 400;
    const keywordsConfigured = m.keywords.length > 0;
    const keywordsMatched =
      keywordsConfigured && keywordResults.some((r) => r.matched);

    let matched: boolean;
    let matchReason: string;
    if (keywordsConfigured) {
      matched = httpOk && keywordsMatched;
      matchReason = matched ? "keyword" : "none";
    } else {
      matched = httpOk;
      matchReason = matched ? "legacy-http-ok" : "http-not-ok";
    }

    const status: CheckOutcome["status"] = matched ? "PASSING" : "FAILING";
    const decisionLine = `[monitor-runner] ${m.name}: check decision → status=${status} reason=${matchReason} httpOk=${httpOk} httpStatus=${fetched.httpStatus} keywordsConfigured=${keywordsConfigured} keywordsMatched=${keywordsMatched}`;
    if (status === "FAILING") {
      console.warn(decisionLine);
    } else {
      console.log(decisionLine);
    }

    return {
      status,
      httpStatus: fetched.httpStatus,
      durationMs,
      errorMessage: null,
      keywordResults,
      markerMissing: false,
      // Carry the screenshot/body through on FAILING so tick() can dump it.
      // PASSING outcomes also carry it but tick() only persists on non-PASSING.
      debug: { screenshot: fetched.screenshot, body: fetched.body },
    };
  } catch (err) {
    const e = err as FetchError;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[monitor-runner] ${m.name}: ERROR fetch threw — ${message}`,
      err instanceof Error && err.stack ? `\n${err.stack}` : "",
    );
    return {
      status: "ERROR",
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      errorMessage: message,
      keywordResults: [],
      markerMissing: false,
      debug: { screenshot: e?.debugScreenshot, body: e?.debugBody },
    };
  }
}

type FetchResult = {
  body: string;
  httpStatus: number;
  screenshot?: Buffer | undefined;
};

type FetchError = Error & {
  debugScreenshot?: Buffer | undefined;
  debugBody?: string | undefined;
};

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
  let page: import("playwright").Page | null = null;
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
    page = await context.newPage();
    const response = await page.goto(m.url, {
      waitUntil: "load",
      timeout: 30_000,
    });
    const httpStatus = response?.status() ?? 0;

    // Give the page time to actually render its dynamic content. Three waits,
    // racing whichever fires first to keep slow pages from blocking forever:
    //   1. If a marker keyword is configured, poll for it in the DOM — it's
    //      the most reliable "the real page rendered" signal.
    //   2. Otherwise (or in parallel), wait for networkidle (10s cap).
    //   3. Plus a small fixed settle delay so post-XHR render passes flush.
    const waitStart = Date.now();
    let markerFound = true;
    if (m.markerKeyword) {
      const found = await page
        .waitForFunction(
          (marker) => document.documentElement.outerHTML.includes(marker),
          m.markerKeyword,
          { timeout: 4_000, polling: 200 },
        )
        .then(() => true)
        .catch(() => false);
      markerFound = found;
    }
    // If the marker never showed up in 4s, skip the rest of the settle waits —
    // the page is wrong (logged out, redirected, or broken) and the caller will
    // trigger a session refresh on the missing-marker outcome.
    if (markerFound) {
      await page
        .waitForLoadState("networkidle", { timeout: 10_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);
    }
    const settleMs = Date.now() - waitStart;

    const body = await page.content();
    const screenshot = await page
      .screenshot({ fullPage: true, type: "png" })
      .catch(() => undefined);

    console.log(
      `[browser] ${m.name} url=${m.url} status=${httpStatus} bytes=${body.length} settle=${settleMs}ms`,
    );
    return { body, httpStatus, screenshot };
  } catch (err) {
    // Attach whatever forensic artifacts we can grab before the context closes,
    // so a failed render still produces a screenshot for the caller to dump.
    const debugScreenshot = page
      ? await page.screenshot({ fullPage: true, type: "png" }).catch(() => undefined)
      : undefined;
    const debugBody = page ? await page.content().catch(() => "") : "";
    const wrapped: FetchError =
      err instanceof Error ? (err as FetchError) : Object.assign(new Error(String(err)));
    wrapped.debugScreenshot = debugScreenshot;
    wrapped.debugBody = debugBody;
    throw wrapped;
  } finally {
    await context.close().catch(() => undefined);
  }
}

function slugifyName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "monitor";
}

const DEBUG_KEEP = 5;

async function pruneOldDumps(monitorDir: string): Promise<void> {
  const entries = await fs.readdir(monitorDir, { withFileTypes: true }).catch(() => []);
  // Folder names start with the ISO timestamp, so lexicographic sort = chronological.
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const toDelete = dirs.slice(0, Math.max(0, dirs.length - DEBUG_KEEP));
  await Promise.all(
    toDelete.map((name) =>
      fs.rm(path.join(monitorDir, name), { recursive: true, force: true }).catch((err) => {
        console.warn(
          `[monitor-runner] failed to prune debug dir ${name}:`,
          err instanceof Error ? err.message : err,
        );
      }),
    ),
  );
}

async function dumpCheckDebug(m: CachedMonitor, outcome: CheckOutcome): Promise<void> {
  if (!outcome.debug || (!outcome.debug.screenshot && !outcome.debug.body)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reason = outcome.markerMissing ? "marker-missing" : outcome.status.toLowerCase();
  const monitorDir = path.join(MONITOR_DEBUG_DIR, slugifyName(m.name));
  const dir = path.join(monitorDir, `${stamp}-${reason}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const writes: Promise<unknown>[] = [];
    if (outcome.debug.screenshot) {
      writes.push(fs.writeFile(path.join(dir, "screenshot.png"), outcome.debug.screenshot));
    }
    if (outcome.debug.body) {
      writes.push(fs.writeFile(path.join(dir, "body.html"), outcome.debug.body));
    }
    const meta = {
      monitor: { id: m.id, name: m.name, url: m.url, markerKeyword: m.markerKeyword },
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      durationMs: outcome.durationMs,
      errorMessage: outcome.errorMessage,
      markerMissing: outcome.markerMissing,
      keywordResults: outcome.keywordResults.map((r) => {
        const k = m.keywords.find((kk) => kk.id === r.keywordId);
        return {
          keywordId: r.keywordId,
          value: k?.value,
          mode: k?.mode,
          matched: r.matched,
        };
      }),
      capturedAt: new Date().toISOString(),
    };
    writes.push(fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2)));
    await Promise.all(writes);
    console.log(
      `[monitor-runner] ${m.name}: ${outcome.status} debug dumped → ${path.resolve(dir)}`,
    );
    await pruneOldDumps(monitorDir);
  } catch (err) {
    console.warn(
      `[monitor-runner] ${m.name}: failed to dump ${outcome.status} debug:`,
      err instanceof Error ? err.message : err,
    );
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
