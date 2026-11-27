# AIVORA — AI Video Creation with Free Tools (₹99 Course)

This project keeps the AIVORA Reel-format public website and its existing 14 portrait images and 6 preview videos, and adds a paid-student course enrolment system with a PostgreSQL-backed Admin Portal.

## Features included

- Existing public AIVORA gallery with 14 images and 6 videos.
- **One-video-at-a-time playback**: starting a preview video pauses every other preview video.
- Course landing page for **AI Video Creation with Free Tools**, priced at **₹99 one-time**.
- Student enrolment form captures name, email, mobile number and a student-created password before checkout.
- Razorpay order creation for ₹99 and server-side signature plus payment-state verification.
- Student account stays `pending` until payment is captured and verified; only then is it activated.
- Student login and private Student Dashboard at `/student`.
- The WhatsApp group invite URL is returned only to an authenticated student whose database access status is `active`.
- Admin Portal at `/admin` with course order and revenue summary, student list, student activation/suspension, and WhatsApp group link management.
- Razorpay `payment.captured` webhook endpoint at `/api/razorpay/webhook` for payment reconciliation if the browser closes after paying.
- Live-class updates and meeting links are intended to be shared inside the private WhatsApp group. **Zoom integration is not enabled in this version**, as previously decided.
- Existing database is migrated safely at startup with `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; existing e-book order rows are retained and labelled `ebook` by default.

## Local project setup

1. Use Node.js 18 or newer.
2. Install packages: `npm install`.
3. Copy `.env.example` to `.env` and enter local development values. Never commit `.env`.
4. Start with `npm start` (or `npm run dev`).
5. PostgreSQL is required for student and admin features.

## Render configuration

Keep the existing Render PostgreSQL Internal Database URL in `DATABASE_URL`. Configure these variables in the Render Environment Group (never in GitHub):

- `NODE_ENV=production`
- `DATABASE_SSL=true`
- `DATABASE_URL=<Render PostgreSQL Internal Database URL>`
- `ADMIN_EMAIL=<existing admin email>`
- `ADMIN_PASSWORD=<existing admin password>`
- `ADMIN_JWT_SECRET=<long random secret>`
- `STUDENT_JWT_SECRET=<different long random secret>` (recommended; otherwise the server falls back to `ADMIN_JWT_SECRET`)
- `RAZORPAY_KEY_ID=<Razorpay key ID>`
- `RAZORPAY_KEY_SECRET=<Razorpay key secret>`
- `RAZORPAY_WEBHOOK_SECRET=<webhook secret>` (recommended for automatic webhook reconciliation)

The admin account that already exists in the current database is retained. Changing `ADMIN_PASSWORD` in Render does not reset the password hash for an existing admin. Do not rotate the admin password/secret during this deployment unless you have a separate reset plan.

Render service commands:

- Build Command: `npm install`
- Start Command: `npm start`

## Razorpay webhook setup

After deploying, configure a webhook in Razorpay with this URL:

`https://YOUR-RENDER-SERVICE.onrender.com/api/razorpay/webhook`

Subscribe to the `payment.captured` event and paste the generated webhook secret into Render as `RAZORPAY_WEBHOOK_SECRET`. The normal checkout callback also verifies the payment server-side; the webhook covers cases where the customer closes the browser after payment.

**Live payment caution:** A live Razorpay checkout can charge real money. Use test credentials in test mode where available. Do not run a live ₹99 payment unless you intend to make that purchase.

## WhatsApp group link

1. Sign in to `/admin` using the existing admin account.
2. In **Private WhatsApp Group**, paste the invite URL in the form `https://chat.whatsapp.com/...` and save it.
3. The admin dashboard can view/update the link. Public visitors and pending/suspended students do not receive it.
4. Only a student with an active, verified course payment can sign in at `/student` and receive the group link from the authenticated student API.

If `WHATSAPP_GROUP_URL` is set in Render before the first startup, it is imported as the initial fallback setting. You can also manage the link inside Admin Portal.

## URLs and checks

- Public website: `/`
- Admin Portal: `/admin`
- Student Login / Dashboard: `/student`
- Health check: `/api/health` (expect `{"ok":true,"database":"connected"}`)

## Important scope notes

- The six MP4 files in `public/media` are public showcase/preview clips, not private paid course lesson videos. They remain public on the marketing page.
- The Student Dashboard protects paid-student account and WhatsApp access. Course lesson videos/materials must be supplied separately before they can be placed in the student learning area.
- Live class meeting URLs are not embedded in the site. They are to be shared by the course operator inside the private WhatsApp group; Zoom integration remains intentionally skipped for now.
- Payment verification relies on the Razorpay API credentials and captured-payment status. Configure and test the correct Razorpay key pair before taking real enrolments.
