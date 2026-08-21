# Admin and PayPal giving service

This Cloudflare Worker supports three protected Admin actions:

1. Changing the Admin password.
2. Reading completed PayPal donations for Josh Beyond Borders.
3. Publishing the updated encrypted workbook and public guitar total in one Git commit.

The Admin password is never stored or sent to the Worker. GitHub contains only the encrypted workbook, its password-wrapped random key, a one-way key fingerprint, and the public total. PayPal credentials and the GitHub token are stored only as encrypted Cloudflare Worker secrets.

## Required Cloudflare secrets

- `GITHUB_TOKEN`: fine-grained GitHub token restricted to `kernbrent/JoshBeyondBorders`, with only **Contents: Read and write**.
- `PAYPAL_CLIENT_ID`: Client ID for a PayPal **Live** REST app owned by the Christian Steps Ministries PayPal account.
- `PAYPAL_CLIENT_SECRET`: matching PayPal Live secret.

Save them from the `worker` directory with hidden Wrangler prompts:

```text
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm exec wrangler secret put PAYPAL_CLIENT_ID
pnpm exec wrangler secret put PAYPAL_CLIENT_SECRET
```

Never add these values to GitHub, `.dev.vars`, website JavaScript, screenshots, or support messages.

## PayPal restrictions

The Worker uses PayPal's read-only Transaction Search API. A transaction is returned to the Admin browser only when all of these checks pass:

- Item Title is exactly `Josh Beyond Borders Donation`.
- Item ID is exactly `BeyondBorders`.
- Status is successfully completed.
- Currency is USD and the gross amount is positive.
- The PayPal event is an incoming general, Express Checkout, or donation payment.
- The record affects the PayPal balance.

Withdrawals, transfers, refunds, reversals, other campaigns, and nonmatching items are not returned. The Admin workbook then rejects duplicate transaction IDs before publishing. The search covers the most recent 93 days in PayPal-compliant 30-day windows; PayPal reports can lag by about three hours.

## Publishing safety

Josh signs in by decrypting the workbook in his browser. The browser sends the random workbook key temporarily so the Worker can verify the active Admin session. The Worker immediately discards it and never logs it.

New donor rows are added to the workbook in the browser. GitHub receives only a freshly encrypted workbook and `data/giving-progress.json`. The Worker creates both files in one Git tree and advances `main` with a non-forced update, so concurrent changes fail safely instead of being overwritten.

## Validate and deploy

```text
pnpm test
pnpm run check
pnpm exec wrangler deploy
```

The route is limited to `joshbeyondborders.org/api/admin/*`. Deploy the Worker before publishing Admin page code that calls the new endpoints.
