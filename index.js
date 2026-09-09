require('dotenv').config();
const http = require('http');
const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');

const CHAT_URL = process.env.CHAT_URL;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'aparat_chat';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'messages';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const PORT = process.env.PORT || 3000;

// وضعیت فعلی برنامه، برای نمایش در صفحه سلامت (health check)
let status = {
  mongoConnected: false,
  pageOpen: false,
  savedCount: 0,
  lastSavedAt: null
};

// یک سرور HTTP بسیار ساده فقط برای اینکه Render آن را به‌عنوان
// «Web Service» بشناسد و بتوان با پینگ دوره‌ای (مثلاً از cron-job.org)
// از خواب رفتنش (spin down) در پلن رایگان جلوگیری کرد.
function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(status, null, 2));
  });
  server.listen(PORT, () => {
    console.log('[health] سرور سلامت روی پورت', PORT, 'در حال اجراست.');
  });
}

if (!CHAT_URL) {
  console.error('لطفاً CHAT_URL را در متغیرهای محیطی تنظیم کنید.');
  process.exit(1);
}
if (!MONGO_URI) {
  console.error('لطفاً MONGO_URI را در متغیرهای محیطی تنظیم کنید.');
  process.exit(1);
}

// متن‌هایی که قبلاً دیده و ذخیره شده‌اند، برای جلوگیری از تکرار
const seenLines = new Set();

async function connectMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('[mongo] با موفقیت به MongoDB Atlas متصل شد.');
  status.mongoConnected = true;
  return client.db(DB_NAME).collection(COLLECTION_NAME);
}

async function openChatPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  console.log('[page] در حال باز کردن:', CHAT_URL);
  await page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[page] صفحه با موفقیت باز شد.');
  status.pageOpen = true;
  return page;
}

async function pollForNewLines(page, collection) {
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
    try {
      await collection.insertOne({ text: line, savedAt: new Date() });
      status.savedCount += 1;
      status.lastSavedAt = new Date().toISOString();
      console.log('[save]', line);
    } catch (err) {
      console.error('[mongo] خطا در ذخیره پیام:', err.message);
    }
  }

  // جلوگیری از رشد بی‌رویه حافظه در اجرای طولانی‌مدت
  if (seenLines.size > 8000) {
    seenLines.clear();
  }
}

async function main() {
  startHealthServer();

  const collection = await connectMongo();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let page = await openChatPage(browser);

  // اگر تب مرورگر به هر دلیلی بسته/کرش شد، دوباره بازش کن
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
      pollForNewLines(page, collection);
    }
  }, POLL_INTERVAL_MS);

  // هر ۱۵ ثانیه صفحه را رفرش می‌کند، برای مواقعی که محتوای جدید
  // (مثل پیام‌های چت) بدون رفرش در DOM به‌روزرسانی نمی‌شود.
  const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || '15000', 10);
  setInterval(async () => {
    if (page && !page.isClosed()) {
      try {
        console.log('[refresh] در حال رفرش صفحه...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[refresh] صفحه رفرش شد.');
      } catch (err) {
        console.error('[refresh] خطا در رفرش صفحه:', err.message);
      }
    }
  }, REFRESH_INTERVAL_MS);

  console.log('[main] پایش پیام‌ها آغاز شد. هر', POLL_INTERVAL_MS, 'میلی‌ثانیه بررسی و هر', REFRESH_INTERVAL_MS, 'میلی‌ثانیه رفرش می‌شود.');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
