import { chromium } from '/home/openclaw/.openclaw/workspace/products/active/multiplayer-tic-tac-toe/e2e/node_modules/playwright/index.mjs';

const input = 'file:///home/openclaw/.openclaw/workspace/products/active/schema-firewall/proxy/schema-firewall-diagram.html';
const output = '/home/openclaw/.openclaw/workspace/products/active/schema-firewall/proxy/schema-firewall-diagram.png';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 });
await page.goto(input, { waitUntil: 'load' });
await page.screenshot({ path: output, fullPage: true });
await browser.close();
console.log(output);
