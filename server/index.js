require('dotenv').config();
const express = require('express');
const fs = require('fs');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3000);
const COURSE_AMOUNT = 9900; // ₹99.00 in paise
const COURSE_TITLE = 'AI Video Creation with Free Tools';
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const STUDENT_JWT_SECRET = process.env.STUDENT_JWT_SECRET || JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const secureCookies = process.env.NODE_ENV === 'production';

const db = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

const razorpayConfigured = Boolean(
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET &&
  !process.env.RAZORPAY_KEY_ID.includes('your_key') &&
  !process.env.RAZORPAY_KEY_SECRET.includes('your_key')
);
const razorpay = razorpayConfigured ? new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
}) : null;

// Razorpay sends a signed raw JSON body. This route must be registered before express.json().
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.get('x-razorpay-signature');
  if (!webhookSecret) return res.status(503).send('Webhook secret is not configured.');
  if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).send('Invalid webhook request.');
  const expected = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(String(signature));
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer))
    return res.status(400).send('Invalid webhook signature.');

  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'payment.captured') {
      const payment = event.payload?.payment?.entity;
      if (payment?.order_id && payment?.id && payment.status === 'captured') {
        await markCourseOrderPaid(payment.order_id, payment.id, payment.email, payment.contact);
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Razorpay webhook processing failed:', error.message);
    res.status(500).send('Webhook processing failed.');
  }
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

function requireDatabase(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database is not configured.' });
  next();
}

function requireAdmin(req, res, next) {
  const token = req.cookies.aivora_admin;
  if (!token || !JWT_SECRET) return res.status(401).json({ error: 'Please log in as admin.' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET, { issuer: 'aivora-admin' });
    next();
  } catch {
    res.clearCookie('aivora_admin', { path: '/' });
    return res.status(401).json({ error: 'Your admin session expired. Please log in again.' });
  }
}

async function requireStudent(req, res, next) {
  const token = req.cookies.aivora_student;
  if (!token || !STUDENT_JWT_SECRET) return res.status(401).json({ error: 'Please log in to your student account.' });
  try {
    const payload = jwt.verify(token, STUDENT_JWT_SECRET, { issuer: 'aivora-student' });
    const result = await db.query(
      `SELECT id, name, email, phone, access_status, paid_at, created_at
       FROM students WHERE id = $1`, [payload.id]
    );
    if (!result.rowCount || result.rows[0].access_status !== 'active') {
      res.clearCookie('aivora_student', { path: '/' });
      return res.status(403).json({ error: 'Course access is not active. Please contact AIVORA support.' });
    }
    req.student = result.rows[0];
    next();
  } catch {
    res.clearCookie('aivora_student', { path: '/' });
    return res.status(401).json({ error: 'Your student session expired. Please log in again.' });
  }
}

function setStudentCookie(res, student) {
  const token = jwt.sign(
    { id: student.id, email: student.email },
    STUDENT_JWT_SECRET,
    { expiresIn: '7d', issuer: 'aivora-student' }
  );
  res.cookie('aivora_student', token, {
    httpOnly: true, secure: secureCookies, sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, path: '/'
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function validWhatsAppGroupUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'chat.whatsapp.com';
  } catch {
    return false;
  }
}

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

    CREATE TABLE IF NOT EXISTS students (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      access_status TEXT NOT NULL DEFAULT 'pending' CHECK (access_status IN ('pending','active','suspended')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ
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

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'ebook';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS student_id BIGINT REFERENCES students(id) ON DELETE SET NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;

    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS orders_product_idx ON orders(product);
    CREATE INDEX IF NOT EXISTS students_access_status_idx ON students(access_status);

    CREATE TABLE IF NOT EXISTS site_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminEmail && adminPassword) {
    const existing = await db.query('SELECT id FROM admins WHERE email = $1', [adminEmail]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await db.query('INSERT INTO admins(email, password_hash) VALUES($1, $2)', [adminEmail, hash]);
      console.log(`Initial admin account created for ${adminEmail}`);
    }
  }

  const configuredGroup = String(process.env.WHATSAPP_GROUP_URL || '').trim();
  if (configuredGroup && validWhatsAppGroupUrl(configuredGroup)) {
    await db.query(
      `INSERT INTO site_settings(setting_key, setting_value) VALUES('whatsapp_group_url', $1)
       ON CONFLICT(setting_key) DO NOTHING`, [configuredGroup]
    );
  }
}

async function markCourseOrderPaid(razorpayOrderId, paymentId, email, phone) {
  if (!db) return;
  const found = await db.query(
    `SELECT id, student_id, product, customer_email, customer_phone
     FROM orders WHERE razorpay_order_id = $1`, [razorpayOrderId]
  );
  if (!found.rowCount) return;
  const order = found.rows[0];
  if (order.product !== 'course' || !order.student_id) return;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE orders SET status='paid', razorpay_payment_id=COALESCE(razorpay_payment_id, $1),
         customer_email=COALESCE(customer_email, $2), customer_phone=COALESCE(customer_phone, $3),
         paid_at=COALESCE(paid_at, NOW()) WHERE id=$4`,
      [paymentId || null, email || order.customer_email || null, phone || order.customer_phone || null, order.id]
    );
    await client.query(
      `UPDATE students SET access_status=CASE WHEN access_status='pending' THEN 'active' ELSE access_status END,
         paid_at=COALESCE(paid_at, NOW()) WHERE id=$1`,
      [order.student_id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
  keyId: razorpayConfigured ? process.env.RAZORPAY_KEY_ID : null,
  enabled: Boolean(razorpay),
  coursePrice: COURSE_AMOUNT,
  courseTitle: COURSE_TITLE
}));

// Public order creation. The account remains pending until Razorpay confirms a captured payment.
app.post('/api/create-order', requireDatabase, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payment checkout is not configured. Please contact AIVORA.' });

  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(req.body.email);
  const phone = String(req.body.phone || '').replace(/[^0-9+]/g, '').trim();
  const password = String(req.body.password || '');
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!/^\+?[0-9]{10,13}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number with 10 to 13 digits.' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Your password must contain at least 8 characters.' });

  try {
    const existing = await db.query('SELECT id, access_status FROM students WHERE email=$1', [email]);
    if (existing.rowCount && existing.rows[0].access_status === 'active')
      return res.status(409).json({ error: 'This email already has course access. Please use Student Login.' });
    if (existing.rowCount && existing.rows[0].access_status === 'suspended')
      return res.status(403).json({ error: 'This student account is suspended. Please contact AIVORA support.' });

    const rpOrder = await razorpay.orders.create({
      amount: COURSE_AMOUNT,
      currency: 'INR',
      receipt: `aivora_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      notes: { product: 'AI Video Creation with Free Tools', student_email: email }
    });

    const passwordHash = await bcrypt.hash(password, 12);
    const client = await db.connect();
    let studentId;
    try {
      await client.query('BEGIN');
      if (existing.rowCount) {
        const updated = await client.query(
          `UPDATE students SET name=$1, phone=$2, password_hash=$3, access_status='pending'
           WHERE id=$4 RETURNING id`, [name, phone, passwordHash, existing.rows[0].id]
        );
        studentId = updated.rows[0].id;
      } else {
        const inserted = await client.query(
          `INSERT INTO students(name,email,phone,password_hash,access_status)
           VALUES($1,$2,$3,$4,'pending') RETURNING id`, [name, email, phone, passwordHash]
        );
        studentId = inserted.rows[0].id;
      }
      await client.query(
        `INSERT INTO orders(razorpay_order_id,amount,currency,status,customer_name,customer_email,customer_phone,product,student_id)
         VALUES($1,$2,'INR','created',$3,$4,$5,'course',$6)`,
        [rpOrder.id, rpOrder.amount, name, email, phone, studentId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.json({
      orderId: rpOrder.id, amount: rpOrder.amount, currency: rpOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID, courseTitle: COURSE_TITLE
    });
  } catch (error) {
    console.error('Course order creation failed:', error.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

app.post('/api/verify-payment', requireDatabase, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: 'Invalid payment details.' });

  try {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(400).json({ error: 'Payment verification failed.' });

    const orderResult = await db.query(
      `SELECT id, amount, currency, product, student_id FROM orders WHERE razorpay_order_id=$1`,
      [razorpay_order_id]
    );
    if (!orderResult.rowCount || orderResult.rows[0].product !== 'course' || !orderResult.rows[0].student_id)
      return res.status(404).json({ error: 'Course order not found.' });
    const order = orderResult.rows[0];

    let payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id || Number(payment.amount) !== Number(order.amount))
      return res.status(400).json({ error: 'Payment does not match this course order.' });
    if (payment.status === 'authorized') {
      payment = await razorpay.payments.capture(razorpay_payment_id, order.amount, order.currency);
    }
    if (payment.status !== 'captured')
      return res.status(402).json({ error: 'Payment has not been captured yet. Please refresh in a moment.' });

    await markCourseOrderPaid(razorpay_order_id, razorpay_payment_id, payment.email, payment.contact);
    const studentResult = await db.query(
      'SELECT id,email FROM students WHERE id=$1 AND access_status=\'active\'', [order.student_id]
    );
    if (studentResult.rowCount) setStudentCookie(res, studentResult.rows[0]);
    res.json({ verified: true, redirectUrl: '/student' });
  } catch (error) {
    console.error('Course payment verification failed:', error.message);
    res.status(500).json({ error: 'Payment verification is being checked. If money was deducted, please contact AIVORA support with your payment ID.' });
  }
});

// Backward compatibility for legacy paid e-book purchases made before the course switch.
app.get('/api/download', requireDatabase, async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(403).send('Payment verification required.');
  const result = await db.query(
    "SELECT id FROM orders WHERE download_token=$1 AND status='paid' AND product='ebook'", [token]
  );
  if (!result.rowCount) return res.status(403).send('Payment verification required.');
  const filePath = path.join(__dirname, '..', 'private', 'ebook.pdf');
  if (!fs.existsSync(filePath)) return res.status(404).send('The legacy e-book PDF is not available on this server. Please contact AIVORA support.');
  res.download(filePath, 'AIVORA-AI-Creator-Guide.pdf');
});

app.post('/api/student/login', requireDatabase, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!validEmail(email) || !password) return res.status(400).json({ error: 'Enter your registered email and password.' });
  try {
    const result = await db.query(
      'SELECT id,name,email,phone,password_hash,access_status FROM students WHERE email=$1', [email]
    );
    if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash)))
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    const student = result.rows[0];
    if (student.access_status !== 'active')
      return res.status(403).json({ error: student.access_status === 'pending' ? 'Your payment is not verified yet. Course access will open after payment confirmation.' : 'Your account is suspended. Please contact AIVORA support.' });
    await db.query('UPDATE students SET last_login_at=NOW() WHERE id=$1', [student.id]);
    setStudentCookie(res, student);
    res.json({ ok: true, name: student.name });
  } catch (error) {
    console.error('Student login failed:', error.message);
    res.status(500).json({ error: 'Could not sign in. Please try again.' });
  }
});

app.post('/api/student/logout', (req, res) => {
  res.clearCookie('aivora_student', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/student/dashboard', requireDatabase, requireStudent, async (req, res) => {
  const setting = await db.query(
    `SELECT setting_value FROM site_settings WHERE setting_key='whatsapp_group_url'`
  );
  const groupUrl = setting.rows[0]?.setting_value || '';
  res.json({
    student: {
      name: req.student.name, email: req.student.email,
      phone: req.student.phone, paidAt: req.student.paid_at
    },
    course: { title: COURSE_TITLE, price: 99, access: 'active' },
    whatsappGroupUrl: groupUrl,
    classInformation: 'Live-class updates and meeting links will be shared by AIVORA in the private WhatsApp group. Zoom integration is not enabled on the website.'
  });
});

app.post('/api/admin/login', requireDatabase, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const result = await db.query('SELECT id,email,password_hash FROM admins WHERE email=$1', [email]);
    if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash)))
      return res.status(401).json({ error: 'Invalid email or password.' });
    if (!JWT_SECRET) return res.status(503).json({ error: 'Admin session secret is not configured.' });
    const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET,
      { expiresIn: '8h', issuer: 'aivora-admin' });
    res.cookie('aivora_admin', token, {
      httpOnly: true, secure: secureCookies, sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000, path: '/'
    });
    res.json({ ok: true, email });
  } catch (error) {
    console.error('Admin login failed:', error.message);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('aivora_admin', { path: '/' });
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email }));

app.get('/api/admin/dashboard', requireDatabase, requireAdmin, async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT COUNT(*) FILTER (WHERE product='course')::int AS total_orders,
        COUNT(*) FILTER (WHERE product='course' AND status='paid')::int AS paid_orders,
        COALESCE(SUM(amount) FILTER (WHERE product='course' AND status='paid'),0)::bigint AS revenue
      FROM orders
    `);
    const studentStats = await db.query(`
      SELECT COUNT(*) FILTER (WHERE access_status='active')::int AS active_students,
        COUNT(*) FILTER (WHERE access_status='pending')::int AS pending_students,
        COUNT(*) FILTER (WHERE access_status='suspended')::int AS suspended_students
      FROM students
    `);
    const orders = await db.query(`
      SELECT razorpay_order_id,razorpay_payment_id,amount,currency,status,product,
        customer_name,customer_email,customer_phone,created_at,paid_at
      FROM orders ORDER BY created_at DESC LIMIT 100
    `);
    const students = await db.query(`
      SELECT s.id,s.name,s.email,s.phone,s.access_status,s.created_at,s.paid_at,
        MAX(o.paid_at) AS last_payment_at
      FROM students s LEFT JOIN orders o ON o.student_id=s.id AND o.status='paid'
      GROUP BY s.id ORDER BY s.created_at DESC LIMIT 200
    `);
    const setting = await db.query(
      `SELECT setting_value FROM site_settings WHERE setting_key='whatsapp_group_url'`
    );
    res.json({
      stats: { ...stats.rows[0], ...studentStats.rows[0] },
      orders: orders.rows,
      students: students.rows,
      settings: { whatsappGroupUrl: setting.rows[0]?.setting_value || '' }
    });
  } catch (error) {
    console.error('Admin dashboard failed:', error.message);
    res.status(500).json({ error: 'Could not load the dashboard.' });
  }
});

app.put('/api/admin/settings/whatsapp-group', requireDatabase, requireAdmin, async (req, res) => {
  const groupUrl = String(req.body.url || '').trim();
  if (groupUrl && !validWhatsAppGroupUrl(groupUrl))
    return res.status(400).json({ error: 'Enter a valid https://chat.whatsapp.com/ invite link.' });
  try {
    await db.query(
      `INSERT INTO site_settings(setting_key,setting_value) VALUES('whatsapp_group_url',$1)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,
      [groupUrl]
    );
    res.json({ ok: true, message: groupUrl ? 'WhatsApp group link saved.' : 'WhatsApp group link removed.' });
  } catch (error) {
    console.error('Saving WhatsApp group URL failed:', error.message);
    res.status(500).json({ error: 'Could not save the WhatsApp group link.' });
  }
});

app.post('/api/admin/students/:id/access', requireDatabase, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '');
  if (!Number.isSafeInteger(id) || id < 1 || !['active', 'suspended'].includes(status))
    return res.status(400).json({ error: 'Invalid student or access status.' });
  try {
    if (status === 'active') {
      const paid = await db.query(
        `SELECT 1 FROM orders WHERE student_id=$1 AND product='course' AND status='paid' LIMIT 1`, [id]
      );
      if (!paid.rowCount)
        return res.status(409).json({ error: 'This student has no verified course payment. Access cannot be activated.' });
    }
    const result = await db.query(
      'UPDATE students SET access_status=$1 WHERE id=$2 RETURNING id,access_status', [status, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Student not found.' });
    res.json({ ok: true, student: result.rows[0] });
  } catch (error) {
    console.error('Updating student access failed:', error.message);
    res.status(500).json({ error: 'Could not update student access.' });
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'student.html')));

initDatabase().then(() => {
  app.listen(PORT, () => console.log(`AIVORA ${COURSE_TITLE} platform running on port ${PORT}`));
}).catch(error => {
  console.error('Startup failed:', error);
  process.exit(1);
});
