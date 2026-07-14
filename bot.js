const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

const bot = new Telegraf(process.env.BOT_TOKEN);

// وضعیت‌های موقت هر چت (فقط در حافظه - برای اسکیل بزرگ باید بره روی Redis/DB)
const pendingTarget = new Map(); // chatId -> targetUserRowId (در حال نوشتن پیام ناشناس)
const settingCustomId = new Set(); // chatId -> در حال وارد کردن آیدی اختصاصی جدید

let botUsername = null;

async function getBotUsername() {
  if (!botUsername) {
    const me = await bot.telegram.getMe();
    botUsername = me.username;
  }
  return botUsername;
}

function buildLink(username, idPart) {
  return `https://t.me/${username}?start=${idPart}`;
}

// --- کیبوردهای منو ---
const mainMenu = Markup.keyboard([
  ['🔗 لینک من', '✏️ تغییر آیدی'],
  ['📖 راهنما'],
]).resize();

const cancelMenu = Markup.keyboard([['❌ لغو ارسال']]).resize();

async function ensureUser(tgUser) {
  return db.upsertUser({
    telegramId: tgUser.id,
    username: tgUser.username,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name,
    languageCode: tgUser.language_code,
  });
}

function userLinkIdPart(user) {
  return user.custom_id || user.id;
}

async function sendMyLink(ctx, user) {
  const username = await getBotUsername();
  const link = buildLink(username, userLinkIdPart(user));
  const idNote = user.custom_id
    ? `آیدی اختصاصی تو: \`${user.custom_id}\``
    : 'هنوز آیدی اختصاصی نساختی — با دکمه «✏️ تغییر آیدی» یکی برای خودت بساز تا لینکت شیک‌تر بشه.';

  return ctx.replyWithMarkdown(
    `این لینک ناشناس توئه، بفرستش برای دوستات:\n\n${link}\n\n${idNote}`,
    mainMenu
  );
}

const HELP_TEXT =
  'راهنما:\n\n' +
  '🔗 لینک من — گرفتن لینک اختصاصی برای اشتراک‌گذاری\n' +
  '✏️ تغییر آیدی — ساخت یا تغییر آیدی اختصاصی (بجای عدد، توی لینکت میاد)\n\n' +
  'وقتی کسی روی لینکت بزنه و پیام بفرسته، برات به صورت ناشناس ارسال میشه. ' +
  'هویتت هیچوقت به گیرنده نشون داده نمیشه، ولی برای رسیدگی به گزارش مزاحمت، اطلاعات حساب فرستنده نزد مدیریت محفوظ می‌مونه.';

bot.start(async (ctx) => {
  const me = await ensureUser(ctx.from);
  const payload = (ctx.startPayload || '').trim();

  if (payload) {
    let target = null;

    if (/^\d+$/.test(payload)) {
      target = await db.getUserById(parseInt(payload, 10));
    } else {
      target = await db.getUserByCustomId(payload);
    }

    if (target && target.id === me.id) {
      return ctx.reply('این لینک خودته! این رو برای دوستات بفرست تا برات پیام ناشناس بفرستن 😉', mainMenu);
    }

    if (!target) {
      return ctx.reply('این لینک معتبر نیست یا کاربر پیدا نشد.', mainMenu);
    }

    pendingTarget.set(ctx.chat.id, target.id);
    return ctx.reply(
      '✉️ پیامت رو بنویس، به صورت ناشناس براش ارسال میشه.',
      cancelMenu
    );
  }

  return ctx.reply(`سلام ${ctx.from.first_name || ''} 👋`, mainMenu).then(() => sendMyLink(ctx, me));
});

bot.command('link', async (ctx) => {
  const me = await ensureUser(ctx.from);
  return sendMyLink(ctx, me);
});

const promptCustomId = (ctx) => {
  settingCustomId.add(ctx.chat.id);
  return ctx.reply(
    'آیدی جدیدت رو بفرست (فقط حروف انگلیسی، عدد و آندرلاین، بین ۳ تا ۳۲ کاراکتر، حتما شامل حداقل یک حرف):',
    Markup.keyboard([['❌ انصراف']]).resize()
  );
};

bot.command('setid', promptCustomId);

bot.hears('❌ لغو ارسال', async (ctx) => {
  pendingTarget.delete(ctx.chat.id);
  return ctx.reply('لغو شد.', mainMenu);
});

bot.hears('❌ انصراف', async (ctx) => {
  settingCustomId.delete(ctx.chat.id);
  return ctx.reply('لغو شد.', mainMenu);
});

bot.hears('🔗 لینک من', async (ctx) => {
  const me = await ensureUser(ctx.from);
  return sendMyLink(ctx, me);
});

bot.hears('✏️ تغییر آیدی', promptCustomId);

bot.hears('📖 راهنما', async (ctx) => ctx.reply(HELP_TEXT, mainMenu));

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return; // دستورها جدا هندل میشن

  // --- حالت: در حال تنظیم آیدی اختصاصی ---
  if (settingCustomId.has(ctx.chat.id)) {
    const candidate = text.trim();

    if (!db.isValidCustomId(candidate)) {
      return ctx.reply('آیدی نامعتبره. فقط حروف انگلیسی، عدد و آندرلاین، ۳ تا ۳۲ کاراکتر و حداقل یک حرف. دوباره امتحان کن:');
    }

    const existing = await db.getUserByCustomId(candidate);
    const me = await ensureUser(ctx.from);

    if (existing && existing.id !== me.id) {
      return ctx.reply('این آیدی قبلا گرفته شده. یه آیدی دیگه امتحان کن:');
    }

    const updated = await db.setCustomId(me.id, candidate);
    settingCustomId.delete(ctx.chat.id);
    return sendMyLink(ctx, updated);
  }

  // --- حالت: در حال نوشتن پیام ناشناس برای یک نفر ---
  const targetId = pendingTarget.get(ctx.chat.id);

  if (!targetId) {
    return ctx.reply('برای شروع، دستور /start رو بزن یا از دکمه‌های پایین استفاده کن.', mainMenu);
  }

  const target = await db.getUserById(targetId);
  if (!target) {
    pendingTarget.delete(ctx.chat.id);
    return ctx.reply('کاربر مقصد دیگه در دسترس نیست.', mainMenu);
  }

  const saved = await db.saveMessage({
    toUserId: target.id,
    // این اطلاعات فقط برای رسیدگی مدیریت به گزارش مزاحمت ذخیره میشه، هیچوقت به گیرنده نشون داده نمیشه
    fromTelegramId: ctx.from.id,
    fromUsername: ctx.from.username,
    fromFirstName: ctx.from.first_name,
    fromLastName: ctx.from.last_name,
    fromLanguageCode: ctx.from.language_code,
    fromIsPremium: ctx.from.is_premium,
    text,
  });

  pendingTarget.delete(ctx.chat.id);

  try {
    await bot.telegram.sendMessage(target.telegram_id, `📩 یک پیام ناشناس جدید داری:\n\n${text}`);
    await db.markDelivered(saved.id);
  } catch (err) {
    console.error('خطا در ارسال پیام به گیرنده:', err.message);
  }

  return ctx.reply('پیامت به صورت ناشناس ارسال شد ✅', mainMenu);
});

module.exports = { bot, getBotUsername };
