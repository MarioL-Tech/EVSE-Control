'use strict';

// Product assets are rendered only in the pinned disposable browser image.
// The original approved SVG and its six paths/colors remain unchanged.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const output = process.env.PWA_ICON_OUTPUT || '/icons';
  await fs.mkdir(output, { recursive: true });
  const source = await fs.readFile('/static/icon.svg', 'utf8');
  const browser = await chromium.launch();
  try {
    for (const [name, size, inset] of [
      ['app-192.png', 192, 0],
      ['app-512.png', 512, 0],
      ['app-maskable-512.png', 512, 112],
      ['apple-touch-icon.png', 180, 0],
    ]) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      // For maskable icons, all identity artwork fits in a 288px square:
      // its diagonal is inside the 409.6px mandatory safe-zone circle.
      await page.setContent(`<!doctype html><html><head><style>
        html,body{margin:0;width:100%;height:100%;background:#f8fbff;overflow:hidden}
        svg{display:block;position:absolute;left:${inset}px;top:${inset}px;
        width:${size - 2 * inset}px;height:${size - 2 * inset}px}
        </style></head><body>${source}</body></html>`);
      await page.screenshot({ path: path.join(output, name) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
