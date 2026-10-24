import { chromium } from "playwright";
import { resolve } from "path";

async function main() {
  const html = resolve(process.argv[2]);
  const pdf = resolve(process.argv[3] || html.replace(/\.html$/, ".pdf"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("file://" + html, { waitUntil: "networkidle" });
  await page.pdf({ path: pdf, width: "1280px", height: "720px", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();
  console.log("PDF written to", pdf);
}

main().catch((e) => { console.error(e); process.exit(1); });