require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const ebookPath = path.join(__dirname, '..', 'private', 'ebook.pdf');
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const db = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

const configured = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET &&
  !process.env.RAZORPAY_KEY_ID.includes('your_key') && !process.env.RAZORPAY_KEY_SECRET.includes('your_key'));
const razorpay = configured ? new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
}) : null;

async function initDatabase() {
  if (!db) {
    console.warn('DATABASE_URL is not configured. Database-backed features are unavailable.');
    return;
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      razorpay_order_id TEXT UNIQUE NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'created',
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      razorpay_payment_id TEXT UNIQUE,
      download_token TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
  `);

  // Bootstrap the first admin only when the configured email does not already exist.
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminEmail && adminPassword) {
    const found = await db.query('SELECT id FROM admins WHERE email = $1', [adminEmail]);
    if (found.rowCount === 0) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await db.query('INSERT INTO admins(email, password_hash) VALUES($1, $2)', [adminEmail, hash]);
      console.log(`Initial admin account created for ${adminEmail}`);
    }
  }
}

function requireDatabase(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database is not configured.' });
  next();
}
function requireAdmin(req, res, next) {
  const token = req.cookies.aivora_admin;
  if (!token || !JWT_SECRET) return res.status(401).json({ error: 'Please log in.' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('aivora_admin');
    return res.status(401).json({ error: 'Your session expired. Please log in again.' });
  }
}

app.get('/api/health', async (req, res) => {
  let database = 'not_configured';
  if (db) {
    try { await db.query('SELECT 1'); database = 'connected'; }
    catch { database = 'error'; }
  }
  res.json({ ok: true, database });
});

app.get('/api/config', (req, res) => res.json({
  keyId: configured ? process.env.RAZORPAY_KEY_ID : null,
  enabled: !!configured
}));

app.post('/api/create-order', requireDatabase, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Checkout is not configured yet. Add Razorpay API keys to the server environment.' });
  try {
    const order = await razorpay.orders.create({
      amount: 19900, currency: 'INR',
      receipt: `aivora_${Date.now()}`,
      notes: { product: 'AIVORA AI Creator E-book' }
    });
    await db.query(
      'INSERT INTO orders(razorpay_order_id, amount, currency, status) VALUES($1, $2, $3, $4)',
      [order.id, order.amount, order.currency, 'created']
    );
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    console.error('Create order failed:', e.message);
    res.status(500).json({ error: 'Could not create payment order.' });
  }
});

app.post('/api/verify-payment', requireDatabase, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!configured || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: 'Invalid payment details.' });

  try {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(400).json({ error: 'Payment verification failed.' });

    const orderResult = await db.query('SELECT * FROM orders WHERE razorpay_order_id = $1', [razorpay_order_id]);
    if (!orderResult.rowCount) return res.status(404).json({ error: 'Order not found.' });
    const orderRow = orderResult.rows[0];

    // Confirm payment state with Razorpay's API, rather than trusting only browser data.
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) return res.status(400).json({ error: 'Payment does not match this order.' });
    if (payment.status === 'authorized') {
      await razorpay.payments.capture(razorpay_payment_id, orderRow.amount, orderRow.currency);
    } else if (payment.status !== 'captured') {
      return res.status(402).json({ error: 'Payment has not been captured.' });
    }

    const downloadToken = orderRow.download_token || crypto.randomBytes(32).toString('hex');
    await db.query(`
      UPDATE orders SET status='paid', razorpay_payment_id=$1, download_token=$2,
        customer_email=$3, customer_phone=$4, paid_at=COALESCE(paid_at, NOW())
      WHERE razorpay_order_id=$5
    `, [razorpay_payment_id, downloadToken, payment.email || null, payment.contact || null, razorpay_order_id]);

    res.json({ verified: true, downloadUrl: `/api/download?token=${encodeURIComponent(downloadToken)}` });
  } catch (e) {
    console.error('Payment verification failed:', e.message);
    res.status(500).json({ error: 'Could not verify payment. Please contact support if money was deducted.' });
  }
});

app.get('/api/download', requireDatabase, async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(403).send('Payment verification required.');
  const result = await db.query("SELECT id FROM orders WHERE download_token=$1 AND status='paid'", [token]);
  if (!result.rowCount) return res.status(403).send('Payment verification required.');
  if (!fs.existsSync(ebookPath)) return res.status(404).send('Your e-book PDF has not been uploaded yet. Please contact AIVORA support.');
  res.download(ebookPath, 'AIVORA-AI-Creator-Guide.pdf');
});

app.post('/api/admin/login', requireDatabase, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const result = await db.query('SELECT id, email, password_hash FROM admins WHERE email=$1', [email]);
  if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash)))
    return res.status(401).json({ error: 'Invalid email or password.' });
  if (!JWT_SECRET) return res.status(503).json({ error: 'Admin session secret is not configured.' });
  const token = jwt.sign({ id: result.rows[0].id, email: result.rows[0].email }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('aivora_admin', token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000, path: '/'
  });
  res.json({ ok: true, email: result.rows[0].email });
});
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('aivora_admin', { path: '/' });
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email }));
app.get('/api/admin/dashboard', requireDatabase, requireAdmin, async (req, res) => {
  const stats = await db.query(`
    SELECT COUNT(*)::int AS total_orders,
      COUNT(*) FILTER (WHERE status='paid')::int AS paid_orders,
      COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::bigint AS revenue
    FROM orders
  `);
  const orders = await db.query(`
    SELECT razorpay_order_id, razorpay_payment_id, amount, currency, status,
      customer_email, customer_phone, created_at, paid_at
    FROM orders ORDER BY created_at DESC LIMIT 100
  `);
  res.json({ stats: stats.rows[0], orders: orders.rows });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

initDatabase().then(() => {
  app.listen(PORT, () => console.log(`AIVORA running on port ${PORT}`));
}).catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
