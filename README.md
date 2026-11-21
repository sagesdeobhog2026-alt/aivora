# AIVORA storefront — first version

A responsive one-page storefront for the ₹199 AIVORA AI Creator e-book.

## Run locally
1. Install Node.js 18+.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env` and add Razorpay **test** API credentials.
4. Put the final PDF at `private/ebook.pdf` (create the `private` folder; do not put the paid PDF in `public`).
5. Run `npm start` and open http://localhost:3000.

## Before accepting real payments
- Replace test keys with live Razorpay keys in the hosting provider's secret environment settings. Never put the key secret in frontend code or share it in chat.
- Configure HTTPS and a persistent order/payment store. This starter uses in-memory paid-order storage, which resets on restart and is not suitable for production. For production, persist orders in a database and validate payment status with Razorpay's API/webhooks before issuing downloads.
- Add your real videos to the gallery and replace the sample placeholder tiles in `public/index.html` with `<video controls playsinline>` elements pointing to your hosted MP4 files.
- Upload your final e-book to `private/ebook.pdf` and test the complete flow using Razorpay test mode.
- Add contact details, privacy policy, terms, refund/cancellation policy and product-specific descriptions.

## Hosting
Deploy this Node/Express project to a Node-compatible host (for example Render or Railway) and use its free subdomain if available on your selected plan. Set environment variables in the host dashboard. Free-tier terms and availability can change.

## Important
This is a first-version starter, not a live store yet. Checkout remains disabled until valid Razorpay credentials are configured. The download endpoint is a starter implementation; upgrade order persistence, webhook reconciliation and rate limiting before production use.
