import fs from "fs/promises";
import path from "path";
import type { Page } from "playwright";
import { getBrowser } from "./browser";

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

export type RefreshResult =
  | { ok: true; cookies: Record<string, string>; finalUrl: string }
  | { ok: false; error: string };

const LOGIN_URL_DEFAULT = "https://admission.1337.ma/users/sign_in";
const LOG_PREFIX = "[cookie-refresher]";
const DEBUG_DIR = process.env.RELOGIN_DEBUG_DIR || "./debug-relogin";

export function loginUrl(): string {
  return process.env.LOGIN_URL || LOGIN_URL_DEFAULT;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

async function dump(page: Page, dir: string, label: string): Promise<void> {
  try {
    const screenshotPath = path.join(dir, `${label}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    await fs.writeFile(path.join(dir, `${label}.html`), html);
    const title = await page.title().catch(() => "");
    const bodyText = (await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => ""))
      .replace(/\s+/g, " ")
      .slice(0, 200);
    console.log(
      `${LOG_PREFIX} [${label}] url=${page.url()} title="${title}" htmlBytes=${html.length} bodyHead="${bodyText}"`,
    );
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} dump(${label}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Logs into admission.1337.ma using LOGIN_EMAIL / LOGIN_PASSWORD and returns
 * the resulting session cookies as a flat name→value map suitable for storing
 * on Monitor.cookies. Throttling and "should this monitor refresh?" decisions
 * live in the caller — this function just performs the login.
 *
 * Forensic dumps (screenshot + HTML + body-text excerpt) are written to
 * RELOGIN_DEBUG_DIR (./debug-relogin by default) under a per-run subdirectory.
 */
export async function refreshLoginCookies(): Promise<RefreshResult> {
  const startedAt = Date.now();
  const email = process.env.LOGIN_EMAIL;
  const password = process.env.LOGIN_PASSWORD;
  if (!email || !password) {
    console.warn(`${LOG_PREFIX} aborting — LOGIN_EMAIL or LOGIN_PASSWORD not set`);
    return { ok: false, error: "LOGIN_EMAIL or LOGIN_PASSWORD not set in env" };
  }

  const target = loginUrl();
  const runDir = path.join(DEBUG_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(runDir, { recursive: true }).catch(() => undefined);
  console.log(`${LOG_PREFIX} starting relogin → ${target} as ${maskEmail(email)}`);
  console.log(`${LOG_PREFIX} debug dir: ${path.resolve(runDir)}`);

  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to acquire browser:`, err);
    return {
      ok: false,
      error: `browser launch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const context = await browser.newContext({
    userAgent: REALISTIC_UA,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "Africa/Casablanca",
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9,fr;q=0.8" },
  });
  console.log(`${LOG_PREFIX} browser context created`);

  try {
    const page = await context.newPage();

    // Forensic page event listeners — print anything the page does that hints
    // at why it's behaving differently than your real browser.
    page.on("console", (msg) => {
      console.log(`${LOG_PREFIX} [page console:${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.warn(`${LOG_PREFIX} [page error] ${err.message}`);
    });
    page.on("requestfailed", (req) => {
      console.warn(
        `${LOG_PREFIX} [request failed] ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "?"}`,
      );
    });
    page.on("response", (res) => {
      const status = res.status();
      if (status >= 400) {
        console.warn(`${LOG_PREFIX} [HTTP ${status}] ${res.request().method()} ${res.url()}`);
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        console.log(`${LOG_PREFIX} [navigated] ${frame.url()}`);
      }
    });

    console.log(`${LOG_PREFIX} navigating to login page`);
    const navStart = Date.now();
    const response = await page.goto(target, { waitUntil: "load", timeout: 30_000 });
    console.log(
      `${LOG_PREFIX} loaded login page in ${Date.now() - navStart}ms (HTTP ${response?.status() ?? "?"})`,
    );

    // Give a moment for the React app to hydrate
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await dump(page, runDir, "01-login-page-loaded");

    // Sanity check the form is actually present — if not, we're probably on a
    // captcha/challenge/different page.
    const emailVisible = await page
      .locator('input[name="email"]')
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    const passwordVisible = await page
      .locator('input[name="password"]')
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    console.log(
      `${LOG_PREFIX} form visibility: email=${emailVisible} password=${passwordVisible}`,
    );
    if (!emailVisible || !passwordVisible) {
      await dump(page, runDir, "02-form-NOT-present");
      return {
        ok: false,
        error:
          "login form not present on the page — likely a captcha, anti-bot challenge, or wrong page (see debug dir)",
      };
    }

    // Use page.type() instead of page.fill() — it dispatches keystrokes (key
    // events) which a few React forms require to mark themselves "dirty" and
    // enable the submit button.
    console.log(`${LOG_PREFIX} typing email field`);
    await page.locator('input[name="email"]').first().click();
    await page.locator('input[name="email"]').first().fill("");
    await page.locator('input[name="email"]').first().type(email, { delay: 20 });

    console.log(`${LOG_PREFIX} typing password field`);
    await page.locator('input[name="password"]').first().click();
    await page.locator('input[name="password"]').first().fill("");
    await page.locator('input[name="password"]').first().type(password, { delay: 20 });

    await dump(page, runDir, "02-fields-filled");

    // Match the confirmed-working browser snippet selector.
    const submitSelector = 'form button[type="submit"]';
    const submitBtn = page.locator(submitSelector).first();
    const submitCount = await page.locator(submitSelector).count();
    console.log(`${LOG_PREFIX} submit selector matches: ${submitCount}`);
    if (submitCount === 0) {
      await dump(page, runDir, "03-no-submit-button");
      console.warn(`${LOG_PREFIX} no ${submitSelector} found — falling back to Enter on password field`);
      await page.locator('input[name="password"]').press("Enter");
    } else {
      const isDisabled = await submitBtn.isDisabled().catch(() => false);
      console.log(`${LOG_PREFIX} submit button disabled? ${isDisabled}`);
      console.log(`${LOG_PREFIX} clicking submit (${submitSelector})`);
      await submitBtn.click({ timeout: 5_000 });
    }

    // Wait for the login to redirect away from /sign_in. If it stays on the
    // sign-in page after a reasonable timeout, the credentials are rejected.
    console.log(`${LOG_PREFIX} waiting for redirect away from /sign_in (timeout 15s)`);
    const waitStart = Date.now();
    let redirected = true;
    await page
      .waitForURL((url) => !url.pathname.endsWith("/sign_in"), { timeout: 15_000 })
      .catch(() => {
        redirected = false;
      });
    console.log(
      `${LOG_PREFIX} ↳ ${redirected ? "redirected" : "did NOT redirect"} after ${Date.now() - waitStart}ms`,
    );

    await page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => undefined);

    await dump(page, runDir, "04-after-submit");

    const finalUrl = page.url();
    console.log(`${LOG_PREFIX} final URL: ${finalUrl}`);

    if (new URL(finalUrl).pathname.endsWith("/sign_in")) {
      // Try to grab any error/flash text the page is showing — Devise apps
      // often render "Invalid email or password" inside .alert / [role=alert].
      const flashText = (
        await page
          .locator('.alert, [role="alert"], .flash, .error, .text-red-500, .text-red-600')
          .first()
          .innerText({ timeout: 2_000 })
          .catch(() => "")
      )
        .replace(/\s+/g, " ")
        .trim();
      console.warn(
        `${LOG_PREFIX} login rejected — still on sign_in after ${Date.now() - startedAt}ms${flashText ? `; flash: "${flashText}"` : ""}`,
      );
      return {
        ok: false,
        error: `login form did not redirect — still at ${finalUrl}${flashText ? ` (flash: ${flashText})` : ""}`,
      };
    }

    const cookies = await context.cookies();
    const map: Record<string, string> = {};
    for (const c of cookies) {
      if (c.name && typeof c.value === "string") {
        map[c.name] = c.value;
      }
    }
    const cookieNames = Object.keys(map);
    console.log(
      `${LOG_PREFIX} extracted ${cookieNames.length} cookies: ${cookieNames.join(", ") || "(none)"}`,
    );

    if (cookieNames.length === 0) {
      return { ok: false, error: "login redirected but no cookies were set" };
    }

    console.log(
      `${LOG_PREFIX} relogin SUCCESS in ${Date.now() - startedAt}ms — ${cookieNames.length} cookies, finalUrl=${finalUrl}`,
    );
    return { ok: true, cookies: map, finalUrl };
  } catch (err) {
    console.error(
      `${LOG_PREFIX} relogin FAILED after ${Date.now() - startedAt}ms:`,
      err,
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close().catch(() => undefined);
    console.log(`${LOG_PREFIX} browser context closed`);
  }
}

/**
 * Returns true if the given monitor URL is in the same registrable domain as
 * the login URL — so we don't try to refresh cookies for an unrelated site
 * just because its marker is missing.
 */
export function shouldAttemptRefresh(monitorUrl: string): boolean {
  try {
    const monitorHost = new URL(monitorUrl).hostname.toLowerCase();
    const loginHost = new URL(loginUrl()).hostname.toLowerCase();
    const loginParts = loginHost.split(".");
    if (loginParts.length < 2) return monitorHost === loginHost;
    const loginBase = loginParts.slice(-2).join(".");
    return monitorHost === loginBase || monitorHost.endsWith("." + loginBase);
  } catch {
    return false;
  }
}
