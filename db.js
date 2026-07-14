const { Pool } = require('pg');

// روی Railway معمولا نیاز به SSL هست ولی certificate خودامضاست
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      custom_id TEXT UNIQUE,
      language_code TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      to_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      from_telegram_id BIGINT,
      from_username TEXT,
      from_first_name TEXT,
      from_last_name TEXT,
      from_language_code TEXT,
      from_is_premium BOOLEAN DEFAULT false,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      delivered BOOLEAN DEFAULT false
    );
  `);

  // ستون‌های جدید برای دیتابیس‌هایی که قبلا با نسخه‌ی قبلی ساخته شدن
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_id TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS language_code TEXT;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_first_name TEXT;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_last_name TEXT;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_language_code TEXT;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_is_premium BOOLEAN DEFAULT false;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_to_user ON messages(to_user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_custom_id ON users(custom_id);`);
  console.log('✅ دیتابیس آماده است');
}

async function upsertUser({ telegramId, username, firstName, lastName, languageCode }) {
  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, language_code)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
                   last_name = EXCLUDED.last_name, language_code = EXCLUDED.language_code
     RETURNING *`,
    [telegramId, username || null, firstName || null, lastName || null, languageCode || null]
  );
  return rows[0];
}

async function getUserByTelegramId(telegramId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserByCustomId(customId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE custom_id = $1', [customId.toLowerCase()]);
  return rows[0] || null;
}

// آیدی اختصاصی: فقط حروف انگلیسی، عدد و آندرلاین، ۳ تا ۳۲ کاراکتر، حتما شامل حداقل یک حرف
// (که با آیدی عددی داخلی قاطی نشه)
function isValidCustomId(id) {
  return /^[a-zA-Z0-9_]{3,32}$/.test(id) && /[a-zA-Z]/.test(id);
}

async function setCustomId(userId, customId) {
  const normalized = customId.toLowerCase();
  const { rows } = await pool.query(
    `UPDATE users SET custom_id = $1 WHERE id = $2 RETURNING *`,
    [normalized, userId]
  );
  return rows[0];
}

async function saveMessage({
  toUserId, fromTelegramId, fromUsername, fromFirstName, fromLastName, fromLanguageCode, fromIsPremium, text,
}) {
  const { rows } = await pool.query(
    `INSERT INTO messages
      (to_user_id, from_telegram_id, from_username, from_first_name, from_last_name, from_language_code, from_is_premium, text, delivered)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
     RETURNING *`,
    [toUserId, fromTelegramId, fromUsername || null, fromFirstName || null, fromLastName || null, fromLanguageCode || null, !!fromIsPremium, text]
  );
  return rows[0];
}

async function markDelivered(messageId) {
  await pool.query('UPDATE messages SET delivered = true WHERE id = $1', [messageId]);
}

// برای پنل ادمین: همه پیام‌ها به همراه اطلاعات کامل فرستنده و گیرنده، با جستجو و صفحه‌بندی
async function listMessages({ page = 1, pageSize = 30, search = '', userId = null }) {
  const offset = (page - 1) * pageSize;
  const params = [];
  let where = '';

  if (userId) {
    params.push(userId);
    where += ` WHERE m.to_user_id = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    where += (where ? ' AND' : ' WHERE') +
      ` (m.text ILIKE $${params.length} OR u.username ILIKE $${params.length} OR u.first_name ILIKE $${params.length}
         OR m.from_username ILIKE $${params.length} OR m.from_first_name ILIKE $${params.length}
         OR m.from_telegram_id::TEXT ILIKE $${params.length})`;
  }

  params.push(pageSize);
  params.push(offset);

  const { rows } = await pool.query(
    `SELECT m.id, m.text, m.created_at,
            m.from_telegram_id, m.from_username, m.from_first_name, m.from_last_name,
            m.from_language_code, m.from_is_premium,
            u.id AS to_user_id, u.username AS to_username, u.first_name AS to_first_name,
            u.custom_id AS to_custom_id, u.telegram_id AS to_telegram_id
     FROM messages m
     JOIN users u ON u.id = m.to_user_id
     ${where}
     ORDER BY m.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM messages m JOIN users u ON u.id = m.to_user_id ${where}`,
    countParams
  );

  return { messages: rows, total: parseInt(countRows[0].count, 10) };
}

async function listUsers() {
  const { rows } = await pool.query(`
    SELECT u.id, u.telegram_id, u.username, u.first_name, u.custom_id, u.created_at,
           COUNT(m.id) AS message_count
    FROM users u
    LEFT JOIN messages m ON m.to_user_id = u.id
    GROUP BY u.id
    ORDER BY message_count DESC
  `);
  return rows;
}

module.exports = {
  pool,
  initDb,
  upsertUser,
  getUserByTelegramId,
  getUserById,
  getUserByCustomId,
  isValidCustomId,
  setCustomId,
  saveMessage,
  markDelivered,
  listMessages,
  listUsers,
};
