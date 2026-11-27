# AIVORA — latest Reel-format storefront + first Admin Portal

This merged package keeps the latest Reel-format public website from `AIVORA-website-v3-reel-format` and adds the PostgreSQL-backed Admin Portal from `aivora-admin-portal-v1`. The public gallery in this package retains its 14 images and 6 videos.

## Included
- Latest Reel-format public website (`public/index.html`)
- Original `public/media/` assets from the latest v3 upload
- Admin login page at `/admin` (`public/admin.html`)
- PostgreSQL tables for admins and orders, created automatically at startup
- First-admin bootstrap using `ADMIN_EMAIL` and `ADMIN_PASSWORD`
- Order/payment dashboard with total orders, paid orders, revenue and latest 100 orders
- Razorpay order creation, server-side signature/payment verification and paid e-book download token

## Render deployment
1. Extract this ZIP. Copy the **contents** of the extracted folder into the existing GitHub repository folder, allowing files to be replaced. Do not delete or replace the repository's hidden `.git` folder. This preserves GitHub Desktop tracking.
2. Confirm Render's Build Command is `npm install` and Start Command is `npm start`.
3. In the Render Environment Group linked to the web service, set `DATABASE_URL` to the PostgreSQL database's **Internal Database URL**. Keep the existing value if it is already correct.
4. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_JWT_SECRET` to your chosen values. Use a unique strong password and a long random secret. Do not put secrets in GitHub or share them in chat.
5. Set `DATABASE_SSL=true` and `NODE_ENV=production` in Render. Keep Razorpay credentials in Render only; use test credentials for testing.
6. Commit and push the updated repository in GitHub Desktop. Render can deploy automatically if auto-deploy is enabled.
7. After deployment, open `/api/health`; expect `{"ok":true,"database":"connected"}`. Then open `/admin` and sign in with the configured admin credentials.

## Important notes
- The first admin account is inserted only if `ADMIN_EMAIL` does not already exist in the database. Changing `ADMIN_PASSWORD` later in Render does **not** reset an existing database password.
- The admin dashboard currently shows **orders and payment records**, not separate student accounts. Student registration, student login, verified-student-only WhatsApp group access, and live class access are future additions.
- `WHATSAPP_GROUP_URL` is reserved and is not exposed by this version.
- The paid PDF must be stored at `private/ebook.pdf`, outside `public/`.
- The portal's first version is not a complete production commerce system: webhook reconciliation, login rate limiting, password reset, audit logging and student management are not yet included. Test with Razorpay test credentials before accepting live payments.
