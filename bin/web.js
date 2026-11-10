// web.js — Layer-2 browser automation CLI (Playwright driving installed Edge/Chrome).
// No screenshots, no OCR, no coordinate guessing.
//
//   node web.js title   <url>
//   node web.js text    <url> [maxChars]
//   node web.js table   <url> <css-selector>        # selector points at <tr>
//   node web.js links   <url> [maxLinks]
//   node web.js click   <url> <css-selector>        # prints title+url after click
//   node web.js type    <url> <selector> <text>     # fill an input, press Enter
//   node web.js shot    <url> <out.png> [width]     # only when you truly need pixels
//
// Flags: --profile <dir>  persist cookies/logins   --headful  show the window
//        --wait <ms>      extra settle time        --cdp <url> attach to running browser

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  } else pos.push(a);
}

const [cmd, ...rest] = pos;
const headless = !flags.headful;

async function open() {
  if (flags.cdp) {
    const b = await chromium.connectOverCDP(String(flags.cdp));
    const ctx = b.contexts()[0] || (await b.newContext());
    return { browser: b, ctx, page: await ctx.newPage(), close: () => b.close() };
  }
  const launchOpts = { headless, args: ["--disable-blink-features=AutomationControlled"] };
  let ctx, browser;
  if (flags.profile) {
    ctx = await chromium.launchPersistentContext(path.resolve(String(flags.profile)), launchOpts);
    return { browser: null, ctx, page: await ctx.newPage(), close: () => ctx.close() };
  }
  for (const extra of [{ channel: "msedge" }, { executablePath: EDGE }, { channel: "chrome" }, { executablePath: CHROME }]) {
    try {
      browser = await chromium.launch({ ...launchOpts, ...extra });
      break;
    } catch {}
  }
  if (!browser) throw new Error("no usable Chromium browser (Edge/Chrome) found");
  ctx = await browser.newContext();
  return { browser, ctx, page: await ctx.newPage(), close: () => browser.close() };
}

(async () => {
  const sess = await open();
  const page = sess.page;
  const out = { cmd };
  try {
    const url = rest[0];
    if (!url) throw new Error("missing url");
    await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
    if (flags.wait) await page.waitForTimeout(Number(flags.wait));
    out.url = page.url();
    out.title = await page.title();

    if (cmd === "title") {
      // done
    } else if (cmd === "text") {
      const max = Number(rest[1] || 4000);
      out.text = await page.evaluate(() => {
        const el = document.body;
        return (el ? el.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
      }).then(t => t.slice(0, max));
    } else if (cmd === "table") {
      const sel = rest[1];
      if (!sel) throw new Error("missing selector");
      out.rows = await page.evaluate((s) => {
        return Array.from(document.querySelectorAll(s)).slice(0, 500).map(tr =>
          Array.from(tr.querySelectorAll("th,td")).map(c => (c.textContent || "").trim()));
      }, sel);
      out.count = out.rows.length;
    } else if (cmd === "links") {
      const max = Number(rest[1] || 40);
      out.links = await page.evaluate((m) => Array.from(document.querySelectorAll("a[href]"))
        .slice(0, m).map(a => ({ text: (a.textContent || "").trim().slice(0, 80), href: a.href })), max);
    } else if (cmd === "click") {
      const sel = rest[1];
      if (!sel) throw new Error("missing selector");
      await page.locator(sel).first().click({ timeout: 20000 });
      await page.waitForTimeout(Number(flags.wait || 1200));
      out.after_url = page.url();
      out.after_title = await page.title();
      out.after_text = await page.evaluate(() =>
        (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000));
    } else if (cmd === "type") {
      const [, sel, text] = rest;
      if (!sel || text === undefined) throw new Error("usage: type <url> <selector> <text>");
      const loc = page.locator(sel).first();
      let method = "click+type";
      try {
        await loc.click({ timeout: 6000 });
        await page.keyboard.type(String(text), { delay: 20 });
      } catch {
        // Fallback for inputs that are attached but not "visible" (hidden originals,
        // overlays, custom-styled search boxes): set the value and dispatch events.
        method = "evaluate+dispatch";
        await page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) throw new Error("selector not found: " + s);
          el.focus();
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, { s: sel, v: String(text) });
      }
      await page.keyboard.press("Enter");
      await page.waitForTimeout(Number(flags.wait || 2500));
      out.method = method;
      out.after_url = page.url();
      out.after_title = await page.title();
      out.after_text = await page.evaluate(() =>
        (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000));
    } else if (cmd === "shot") {
      const file = rest[1];
      if (!file) throw new Error("missing output path");
      const w = Number(rest[2] || 1440);
      await page.setViewportSize({ width: w, height: 900 });
      await page.screenshot({ path: file, fullPage: flags.full === true });
      out.saved = path.resolve(file);
      out.bytes = fs.statSync(file).size;
    } else {
      throw new Error("unknown command: " + cmd);
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    await sess.close().catch(() => {});
  }
  console.log(JSON.stringify(out, null, 2));
})();
