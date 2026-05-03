import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser } from "playwright";

chromiumExtra.use(StealthPlugin());

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromiumExtra
      .launch({
        headless: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
      })
      .then((b) => {
        console.log("[browser] launched chromium with stealth");
        b.on("disconnected", () => {
          console.warn("[browser] chromium disconnected");
          browserPromise = null;
        });
        return b as unknown as Browser;
      });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch (err) {
    console.error("[browser] close failed:", err);
  } finally {
    browserPromise = null;
  }
}
