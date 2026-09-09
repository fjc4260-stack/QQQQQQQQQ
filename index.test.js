require('dotenv').config();
const http = require('http');
const puppeteer = require('puppeteer');

const CHAT_URL = process.env.CHAT_URL;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const PORT = process.env.PORT || 3000;

if (!CHAT_URL) {
  console.error('لطفاً CHAT_URL را در متغیرهای محیطی تنظیم کنید.');
  process.exit(1);
}

// وضعیت فعلی برنامه، برای نمایش در صفحه وضعیت
let status = {
  mode: 'TEST (بدون MongoDB)',
  pageOpen: false,
  linesSeenCount: 0,
  lastLines: []
};

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(status, null, 2));
  });
  server.listen(PORT, () => {
    console.log('[health] سرور وضعیت روی پورت', PORT, 'در حال اجراست.');
  });
}

// متن‌هایی که قبلاً دیده شده‌اند
const seenLines = new Set();

async function openChatPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  console.log('[page] در حال باز کردن:', CHAT_URL);
  await page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[page] صفحه با موفقیت باز شد. (حالت تست - چیزی ذخیره نمی‌شود)');
  status.pageOpen = true;
  return page;
}

async function pollForNewLines(page) {
  // علاوه بر صفحه اصلی، تمام iframeهای داخل صفحه را هم بررسی می‌کنیم
  // چون خیلی از سایت‌ها (احتمالاً از جمله آپارات) چت لایو را داخل
  // یک iframe جدا نمایش می‌دهند و متن آن در document.body صفحه اصلی نیست.
  const frames = page.frames();
  let allLines = [];

  for (const frame of frames) {
    try {
      const frameText = await frame.evaluate(() => document.body ? (document.body.innerText || '') : '');
      const frameLines = frameText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      allLines = allLines.concat(frameLines);
    } catch (err) {
      // بعضی frameها (مثل تبلیغات یا about:blank) ممکن است قابل خواندن نباشند؛ نادیده می‌گیریم
    }
  }

  const newLines = allLines.filter((line) => !seenLines.has(line));

  for (const line of newLines) {
    seenLines.add(line);
    status.linesSeenCount += 1;
    status.lastLines.push(line);
    if (status.lastLines.length > 20) {
      status.lastLines.shift(); // فقط ۲۰ خط آخر را نگه دار
    }
    console.log('[seen]', line);
  }

  if (seenLines.size > 8000) {
    seenLines.clear();
  }
}

async function main() {
  startHealthServer();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let page = await openChatPage(browser);

  page.on('close', async () => {
    status.pageOpen = false;
    console.warn('[page] صفحه بسته شد. تلاش برای باز کردن دوباره...');
    try {
      page = await openChatPage(browser);
    } catch (err) {
      console.error('[page] باز کردن دوباره صفحه شکست خورد:', err.message);
    }
  });

  setInterval(() => {
    if (page && !page.isClosed()) {
      pollForNewLines(page);
    }
  }, POLL_INTERVAL_MS);

  console.log('[main] حالت تست آغاز شد (بدون MongoDB). هر', POLL_INTERVAL_MS, 'میلی‌ثانیه بررسی می‌شود.');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
