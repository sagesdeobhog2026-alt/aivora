require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
const ebookPath = path.join(__dirname, '..', 'private', 'ebook.pdf');
const configured = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && !process.env.RAZORPAY_KEY_ID.includes('your_key');
const razorpay = configured ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }) : null;
const paidOrders = new Set();
app.get('/api/config', (req, res) => res.json({ keyId: configured ? process.env.RAZORPAY_KEY_ID : null, enabled: !!configured }));
app.post('/api/create-order', async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Checkout is not configured yet. Add Razorpay API keys to the server environment.' });
  try {
    const order = await razorpay.orders.create({ amount: 19900, currency: 'INR', receipt: `aivora_${Date.now()}`, notes: { product: 'AIVORA AI Creator E-book' } });
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not create payment order.' }); }
});
app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!configured || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Invalid payment details.' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(razorpay_signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'Payment verification failed.' });
  paidOrders.add(razorpay_order_id);
  res.json({ verified: true, downloadUrl: `/api/download?order=${encodeURIComponent(razorpay_order_id)}` });
});
app.get('/api/download', (req, res) => {
  const order = String(req.query.order || '');
  if (!paidOrders.has(order)) return res.status(403).send('Payment verification required.');
  if (!fs.existsSync(ebookPath)) return res.status(404).send('Your e-book PDF has not been uploaded yet. Please contact AIVORA support.');
  res.download(ebookPath, 'AIVORA-AI-Creator-Guide.pdf');
});
app.listen(process.env.PORT || 3000, () => console.log(`AIVORA running on port ${process.env.PORT || 3000}`));
