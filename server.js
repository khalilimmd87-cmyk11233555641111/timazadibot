require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const db = require('./db');
const { bot, getBotUsername } = require('./bot');

const app = express();
app.use(express.json());

const PgSessionStore = new pgSession({
  pool: db.pool,
  createTableIfMissing: true,
});

app.use(
  session({
    store: PgSessionStore,
    secret: process.env.SESSION_SECRET || 'please-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // یک هفته
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  })
);

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---------- API پنل مدیریت ----------

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'نام کاربری یا رمز اشتباهه' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get('/api/messages', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const search = req.query.search || '';
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const result = await db.listMessages({ page, pageSize: 30, search, userId });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.listUsers();
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- سرو کردن فایل‌های استاتیک پنل ----------
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ---------- راه‌اندازی ربات ----------

async function startBot() {
  await db.initDb();

  const usePolling = process.env.USE_POLLING === 'true';

  if (usePolling) {
    console.log('🤖 بات در حالت polling (لوکال) اجرا شد');
    await bot.launch();
  } else {
    const domain =
      process.env.WEBHOOK_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : null);

    if (!domain) {
      console.warn(
        '⚠️ WEBHOOK_URL ست نشده و RAILWAY_PUBLIC_DOMAIN هم پیدا نشد. بات بدون webhook بالا میاد (پیام دریافت نمی‌کنه).'
      );
      return;
    }

    const secretPath = `/webhook/${process.env.BOT_TOKEN.split(':')[0]}`;
    app.use(bot.webhookCallback(secretPath));
    await bot.telegram.setWebhook(`${domain}${secretPath}`);
    console.log(`🤖 Webhook ست شد روی: ${domain}${secretPath}`);
  }

  const username = await getBotUsername();
  console.log(`🤖 بات آماده است: https://t.me/${username}`);
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 سرور روی پورت ${PORT} بالا اومد`);
  try {
    await startBot();
  } catch (err) {
    console.error('❌ خطا در راه‌اندازی بات:', err);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
