/* =============================================================================
 * Browser DevTools snippet to test the relogin flow against admission.1337.ma
 * =============================================================================
 *
 * HOW TO USE:
 *   1. Open https://admission.1337.ma/users/sign_in in a real browser
 *      (logged out — incognito is easiest).
 *   2. Open DevTools → Console.
 *   3. Paste the WHOLE contents of this file and press Enter.
 *      It registers a global `relogin` helper but does NOT submit yet.
 *   4. Run a dry-run (selectors only, no credentials needed):
 *          relogin.dryRun()
 *      You'll see ✓/✗ for the email/password/button selectors.
 *   5. Run the full flow (this WILL log you in):
 *          relogin.run({ email: "you@example.com", password: "your-password" })
 *
 * Notes:
 *   - HttpOnly session cookies are NOT visible via document.cookie. To verify
 *     that the server-side relogin will pick them up, open DevTools →
 *     Application → Cookies → https://admission.1337.ma after `relogin.run`
 *     completes — that's what Playwright sees.
 *   - The button selector mirrors the server-side fallback chain:
 *       1) button[class*="bg-[#6faf4d]"]
 *       2) form button[type="submit"]
 *       3) Enter on the password field
 *   - Pass { dry: true } to .run() to skip the actual submit (useful if you
 *     just want to confirm fill works without authenticating).
 * ============================================================================= */

(function () {
  if (window.relogin) {
    console.log("[relogin] re-registering helper (already loaded once)");
  }

  const LOG = (...args) => console.log("%c[relogin]", "color:#1565a0;font-weight:bold", ...args);
  const WARN = (...args) => console.warn("%c[relogin]", "color:#c4150c;font-weight:bold", ...args);
  const OK = (...args) => console.log("%c[relogin] ✓", "color:#2c5f17;font-weight:bold", ...args);

  const SELECTORS = {
    email: 'input[name="email"]',
    password: 'input[name="password"]',
    submitPrimary: 'button[class*="bg-[#6faf4d]"]',
    submitFallback: 'form button[type="submit"]',
  };

  function reactNativeSet(el, value) {
    // React/Vue overwrite native setters; this triggers their internal change
    // handlers so the form treats the value as user input, not script-set.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findOne(selector, label) {
    const el = document.querySelector(selector);
    if (el) {
      OK(`${label} found:`, selector);
      return el;
    }
    WARN(`${label} NOT found:`, selector);
    return null;
  }

  function dryRun() {
    LOG("=== Selector dry-run ===");
    LOG("URL:", location.href);
    const email = findOne(SELECTORS.email, "email input");
    const password = findOne(SELECTORS.password, "password input");
    const primary = findOne(SELECTORS.submitPrimary, "primary submit button");
    const fallback = findOne(SELECTORS.submitFallback, "fallback submit button");

    const cookies = document.cookie ? document.cookie.split(";").map((c) => c.trim().split("=")[0]) : [];
    LOG("non-HttpOnly cookies currently visible:", cookies.length ? cookies : "(none)");
    LOG("(HttpOnly session cookies are not listed here — see Application → Cookies tab)");

    const ok = email && password && (primary || fallback);
    if (ok) OK("dry-run PASSED — selectors look ready");
    else WARN("dry-run FAILED — fix the missing selector(s) above");
    return { email: !!email, password: !!password, primary: !!primary, fallback: !!fallback, ok };
  }

  async function waitFor(predicate, { timeout = 15000, interval = 200, label = "condition" } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        if (await predicate()) return true;
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    WARN(`timeout (${timeout}ms) waiting for ${label}`);
    return false;
  }

  async function run(opts = {}) {
    const { email, password, dry = false } = opts;
    if (!email || !password) {
      WARN("run() requires { email, password } — pass them as an object argument");
      return { ok: false, error: "missing credentials" };
    }

    const startedAt = Date.now();
    LOG("=== Starting relogin flow ===");
    LOG("dry mode:", dry, "| email:", email.replace(/(.{2}).+(@.+)/, "$1***$2"));

    const emailEl = findOne(SELECTORS.email, "email input");
    const passwordEl = findOne(SELECTORS.password, "password input");
    if (!emailEl || !passwordEl) {
      WARN("aborting — required fields missing");
      return { ok: false, error: "fields not found" };
    }

    LOG("filling email field");
    reactNativeSet(emailEl, email);
    LOG("filling password field");
    reactNativeSet(passwordEl, password);

    if (dry) {
      OK("dry mode — fields filled, NOT submitting");
      return { ok: true, dry: true, elapsedMs: Date.now() - startedAt };
    }

    const startUrl = location.href;
    let submitted = false;

    const primaryBtn = document.querySelector(SELECTORS.submitPrimary);
    if (primaryBtn) {
      LOG("clicking primary submit button (bg-[#6faf4d])");
      primaryBtn.click();
      submitted = true;
    } else {
      WARN("primary submit not found, trying fallback");
      const fallbackBtn = document.querySelector(SELECTORS.submitFallback);
      if (fallbackBtn) {
        LOG("clicking fallback submit (form button[type=submit])");
        fallbackBtn.click();
        submitted = true;
      } else {
        WARN("no submit button found — pressing Enter on password field");
        passwordEl.focus();
        passwordEl.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }),
        );
        passwordEl.dispatchEvent(
          new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }),
        );
        passwordEl.form?.requestSubmit?.();
        submitted = true;
      }
    }

    LOG("waiting up to 15s for redirect away from /sign_in");
    const navStart = Date.now();
    const redirected = await waitFor(
      () => !location.pathname.endsWith("/sign_in"),
      { timeout: 15000, label: "redirect" },
    );
    LOG(`redirect wait finished after ${Date.now() - navStart}ms — redirected: ${redirected}`);
    LOG("startUrl:", startUrl);
    LOG("finalUrl:", location.href);

    const visibleCookies = document.cookie
      ? document.cookie.split(";").map((c) => c.trim().split("=")[0])
      : [];
    LOG("non-HttpOnly cookies visible after submit:", visibleCookies.length ? visibleCookies : "(none)");
    LOG("To see ALL cookies (incl. HttpOnly session): DevTools → Application → Cookies → https://admission.1337.ma");

    const result = {
      ok: redirected && !location.pathname.endsWith("/sign_in"),
      redirected,
      submitted,
      startUrl,
      finalUrl: location.href,
      visibleCookies,
      elapsedMs: Date.now() - startedAt,
    };

    if (result.ok) OK(`relogin SUCCESS in ${result.elapsedMs}ms`);
    else WARN(`relogin FAILED — still at ${location.href}`);

    return result;
  }

  window.relogin = { dryRun, run, SELECTORS };
  OK("helper registered — try `relogin.dryRun()` or `relogin.run({email,password})`");
})();
