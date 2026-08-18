# Josh Beyond Borders Developer and Operations Guide

Last verified: August 17, 2026

This is the technical handoff document for the Josh Beyond Borders website. It explains the repository, production architecture, update procedures, Admin Portal, Cloudflare Worker, external services, and secrets.

## 1. Read this first

- Production site: <https://joshbeyondborders.org>
- Source repository: <https://github.com/kernbrent/JoshBeyondBorders>
- Primary branch: `main`
- Frontend: static HTML, CSS, and browser JavaScript; there is no frontend build step or framework.
- Server-side code: one Cloudflare Worker under `worker/`.
- Sensitive donor data: stored only as an encrypted workbook in the public repository.
- Deployment: Cloudflare Pages project `joshbeyondborders`, connected to GitHub branch `main`. The API is a separately deployed Cloudflare Worker defined under `worker/`.

Do not put passwords, access tokens, recovery material, or unencrypted donor reports in this repository. This guide documents secret names, locations, consumers, and rotation procedures, but intentionally contains no live secret values.

## 2. Architecture at a glance

```text
Visitor's browser
├── Static site: HTML + CSS + scripts/main.js
│   ├── Google Fonts
│   ├── Spotify Embed API
│   ├── PayPal Hosted Buttons
│   └── data/giving-progress.json
└── /admin
    ├── Loads encrypted workbook from /api/admin/workbook
    ├── Falls back to admin/resources/giving-workbook.enc.json
    ├── Decrypts the workbook entirely in the browser
    ├── Can prepare two replacement JSON files from an .xlsx file
    └── Posts password-wrapper changes to /api/admin/change-password
        └── Cloudflare Worker
            ├── Reads GITHUB_TOKEN from encrypted Worker secrets
            ├── Reads the encrypted workbook through the GitHub Contents API
            └── Commits only a new encrypted password wrapper to main
```

There is no application database, server-side user table, login session, CMS, or frontend dependency installation. The only production write operation is the Worker's update of the encrypted workbook file when the Admin password changes.

## 3. Repository map

| Path | Purpose |
| --- | --- |
| `index.html` | Home page: story, journey, mission, partners summary, featured songs, and giving call to action. |
| `pages/about.html` | Josh's biography, social/music links, press kit, and partners callout. |
| `pages/testimony.html` | Long-form testimony page. |
| `pages/listen.html` | Spotify songs, playlist, artist, and album embeds. |
| `pages/giving.html` | Giving progress, route graphic, PayPal/Venmo donation widget, and use-of-funds copy. |
| `pages/partners.html` | Partner organizations. Cards are shuffled in the browser. |
| `pages/player.html` | Older standalone Spotify player. Nothing in the current site links to it. Treat it as legacy unless it is deliberately restored. |
| `styles/main.css` | Base site styles plus most page-specific styles. It also imports DM Sans and Playfair Display from Google Fonts. |
| `styles/experiment.css` | The active visual override layer: palette, Oswald/Special Elite typography, texture, framing, and later design refinements. It loads after `main.css`. |
| `scripts/main.js` | Shared behavior: year, mobile menu, giving-progress fetch, partner shuffling, Spotify playback coordination, and footer developer credit. |
| `assets/` | Logo/hero art, Career Steps logo, and social-service SVG icons. |
| `images/` | Content photographs and giving-page graphics. |
| `data/giving-progress.json` | Public fundraising total used by the giving-page meter. No donor details belong here. |
| `admin/index.html` | Admin Portal markup. |
| `admin/admin.css` | Admin-only styles. |
| `admin/admin.js` | Client-side login/decryption, optional remembered password, report preparation, and Admin password change flow. |
| `admin/resources/JoshBeyondBorders-Donor-Giving-Letter-Template.docx` | Donor letter template. It is a static public file even though its link is shown only after Admin login. |
| `admin/resources/giving-workbook.enc.json` | Encrypted donor workbook plus password-wrapped data key and key fingerprint. It is safe to publish only while it remains encrypted. |
| `worker/src/index.ts` | Cloudflare Worker API implementation. |
| `worker/wrangler.jsonc` | Worker name, route, public variables, required secret declaration, and observability settings. |
| `worker/test/password-change.spec.ts` | Worker security and password-change tests. |
| `worker/package.json` | Worker dependencies and validation commands. |
| `worker/worker-configuration.d.ts` | Generated Worker environment typings. Regenerate after binding changes. |
| `.gitignore` | Excludes local environments, dependencies, build output, logs, and unencrypted donor spreadsheets. |
| `components/`, `fonts/`, `docs/` | `components/` and `fonts/` are currently empty. `docs/` contains this guide. |

Navigation, headers, and footers are duplicated in the HTML files. A navigation change normally has to be made on every public page. The footer developer credit is added at runtime by `scripts/main.js`.

## 4. Public-site behavior

### Shared JavaScript

`scripts/main.js` is loaded directly by the pages and provides:

1. The current copyright year.
2. The responsive menu and Escape-key behavior.
3. The fundraising meter. On `pages/giving.html`, it fetches `data/giving-progress.json` with `cache: "no-store"`, validates `raised` and `goal`, and updates the visual meter and accessible progress values.
4. Partner-card shuffling on `pages/partners.html`. The previous order is kept in `sessionStorage` so the immediately repeated order is avoided.
5. Spotify player coordination so only one embedded song/player is active at a time.
6. The Career Steps Consulting LLC footer credit.

### Styling

`main.css` is the foundation. `experiment.css` intentionally overrides many of its variables and selectors and therefore must remain after it in each page's `<head>`. The visual design currently depends on both files.

The CSS links use query-string version numbers as manual cache busters. When changing CSS or JavaScript, update the corresponding `?v=...` value on every page that loads that asset. Existing page versions are not fully synchronized, so search the whole repository rather than updating only one page.

### Third-party browser services

| Service | Where used | What it supports |
| --- | --- | --- |
| Google Fonts | `styles/main.css`, `styles/experiment.css` | DM Sans, Playfair Display, Oswald, and Special Elite. |
| Spotify Embed API | Home, Listen, and legacy Player pages | Featured tracks and embedded Spotify content. |
| PayPal Hosted Buttons | `pages/giving.html` | PayPal, Venmo, and supported-card donations processed for Christian Steps Ministries. |
| Social/music sites | `pages/about.html` | TikTok, Facebook, YouTube, Patreon, SoundCloud, Apple Music, Bandcamp, Canva press kit, and Linktree. |

Spotify IDs, the PayPal browser client ID, and the PayPal hosted-button ID are public content/account identifiers, not secrets. They must remain in the HTML for the embeds to work.

## 5. Giving-data workflow

The site deliberately separates public progress from private donor records.

### Public file

`data/giving-progress.json` contains:

- `raised`: public total raised;
- `goal`: current public goal;
- `percent`: generated convenience value;
- `updatedAt`: display timestamp;
- `sourceCell`: the workbook cell used to calculate the total.

The browser recalculates the displayed percentage from `raised / goal`; it does not trust the stored `percent` field.

### Private workbook

The donor workbook is stored only inside `admin/resources/giving-workbook.enc.json`. The current format is version 2 envelope encryption:

- workbook data is encrypted with a random 256-bit AES-GCM data key;
- the Admin password is processed with PBKDF2-SHA-256;
- the password-derived key encrypts (wraps) the workbook data key;
- the file also contains a SHA-256 fingerprint of the data key so the Worker can verify an authenticated password-change request;
- salts, IVs, ciphertext, the wrapped key, and the fingerprint are not passwords, but they must not be edited manually.

Current production-compatible parameters are `AES-256-GCM-ENVELOPE`, PBKDF2-SHA-256, and 310,000 PBKDF2 iterations. The current payload has no recovery access field.

### Publishing a new report

1. Open <https://joshbeyondborders.org/admin> and sign in.
2. Choose the latest `.xlsx` donor workbook.
3. The browser unpacks the workbook locally and looks for exactly one yellow numeric cell in column I across the worksheets.
4. Select **Prepare secure update files**.
5. Download both generated files:
   - `giving-progress.json`
   - `giving-workbook.enc.json`
6. Replace `data/giving-progress.json` and `admin/resources/giving-workbook.enc.json` in the repository.
7. Review the public JSON to ensure it has only aggregate information. Never add names, emails, individual gifts, or other donor information.
8. Test the giving page and Admin login locally.
9. Commit and push both files together through the normal reviewed release process.

The Admin Portal prepares downloads only; it does not upload or publish these two report files. The repository update is a separate developer operation.

If the workbook contains no qualifying yellow total, or more than one yellow numeric cell in column I, preparation stops with an error. The public goal is also hard-coded as `GIVING_GOAL` in `admin/admin.js`; keep it synchronized with the public file and page copy if the goal changes.

## 6. Admin Portal security model

The Admin Portal is not protected by server-side page authentication. Anyone can load `/admin`, the donor-letter template's direct URL, and the encrypted workbook file. Confidentiality comes from encryption, not from hiding URLs or HTML controls.

The login flow is:

1. The browser fetches the encrypted payload from `GET /api/admin/workbook` in production. If that fails, it tries the static encrypted JSON file.
2. The supplied Admin password derives a browser-only wrapping key.
3. The browser unwraps the random workbook data key.
4. The workbook is decrypted in browser memory and exposed as a temporary object URL for download.
5. Signing out or leaving the page clears active JavaScript references and revokes temporary download URLs.

The password-change flow is:

1. A successful workbook decryption proves knowledge of the current Admin password.
2. The browser wraps the existing workbook data key with the new password.
3. It sends the raw data key and new encrypted wrapper over HTTPS to `POST /api/admin/change-password`. Neither the old nor new password is sent.
4. The Worker fetches the current encrypted payload from GitHub and compares the key's SHA-256 digest using a timing-safe comparison.
5. If verified, the Worker uses the GitHub Contents API to commit only the new password wrapper to `main` with the message `Change Admin password`.

The raw data key exists temporarily in the browser and Worker request memory during a password change. The Worker does not intentionally log or persist it and overwrites its local byte array after verification.

### Remembered password

When **Remember the password on this browser** is selected, `admin/admin.js` creates a non-extractable AES-GCM device key and stores it in the origin's IndexedDB database `josh-beyond-borders-admin`. The Admin password is stored only as AES-GCM ciphertext beside that device key.

- This remembered state is local to that browser profile and does not transfer to another developer.
- Clearing site data removes it.
- Unchecking the option removes both records.
- Signing out does not remove the remembered password; it can be restored on the next login screen.
- Treat any device with this option enabled as an authorized device.

## 7. Cloudflare Worker API

The Worker is named `josh-beyond-borders-admin-api` and is routed only to:

```text
joshbeyondborders.org/api/admin/*
```

`workers_dev` and preview URLs are disabled. The configured production origin is `https://joshbeyondborders.org`.

### Endpoints

| Method and path | Authentication/validation | Result |
| --- | --- | --- |
| `GET /api/admin/workbook` | No login; encrypted data is intentionally public | Returns the current encrypted payload from GitHub with `Cache-Control: no-store`. |
| `POST /api/admin/change-password` | Requires the configured same origin, JSON body, bounded request size, a structurally valid password wrapper, and the correct 32-byte workbook data key | Commits the new password wrapper to GitHub. |
| `OPTIONS /api/admin/*` | Same-origin validation | CORS preflight response. |

Other paths return 404. API responses include restrictive caching, framing, content-type, referrer, and CSP headers. Unexpected errors are logged with a request ID, method, and path, but request bodies are not intentionally logged.

### Non-secret Worker variables

These values are committed in `worker/wrangler.jsonc` and are safe to disclose:

| Binding | Purpose |
| --- | --- |
| `ALLOWED_ORIGIN` | Allows password changes only from the production site's browser origin. |
| `GITHUB_OWNER` | GitHub repository owner used by the Contents API. |
| `GITHUB_REPO` | Repository name used by the Contents API. |
| `GITHUB_BRANCH` | Branch the Worker reads and updates. |
| `WORKBOOK_PATH` | Encrypted payload path the Worker reads and updates. |

Changing the repository, branch, file path, or production hostname requires updating these variables and redeploying the Worker.

## 8. Secrets and sensitive material inventory

Secret values must be transferred separately through an approved password manager or by rotating them during handoff. Never paste them into this guide, an issue, a commit, chat, or email.

| Item | Where it lives | Why it was created / what it supports | Rotation or handoff |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Cloudflare encrypted Worker secret; consumed as `env.GITHUB_TOKEN` | A fine-grained GitHub PAT lets the Worker read and update only the encrypted workbook in `kernbrent/JoshBeyondBorders`. It needs repository **Contents: Read and write** and no broader permission. | Create a replacement fine-grained PAT, set it from `worker/` with `pnpm exec wrangler secret put GITHUB_TOKEN`, verify the Admin API, then revoke the old PAT. Existing Cloudflare secret values cannot be recovered for display. Record the owner and expiration date in the private password manager. |
| Admin password | Known by the authorized site administrator; optionally encrypted in that browser's IndexedDB | Decrypts the password-wrapped workbook key and therefore unlocks the donor workbook. It is not stored in GitHub or Cloudflare and is never sent to the Worker. | Transfer through a password manager or change it in the live Admin Portal. The current payload has no recovery access. If every copy of the password and every unlocked workbook backup is lost, the encrypted workbook cannot be recovered. |
| Workbook data key | Random 32-byte value; stored only in password-wrapped form in the encrypted JSON; temporarily clear in browser memory and a password-change request | Encrypts the workbook independently of the human password. This lets the password be changed by rewrapping the key without decrypting donor data on the server. | A normal password change does not rotate this key. Full key rotation requires decrypting the workbook and producing a newly encrypted payload with a new random key. There is no one-click key-rotation workflow. |
| Workbook-key fingerprint | Public SHA-256 digest inside the encrypted JSON | Lets the Worker validate that a password-change caller has the correct workbook data key without storing the key itself. | Recalculate only when the workbook data key is fully rotated. It is verification material, not a login password. |
| Browser remembered-password device key | Non-extractable AES-GCM key in IndexedDB on an opted-in browser | Encrypts the remembered Admin password on that specific browser profile. | Clear site data or uncheck **Remember the password**. It is not transferable; the successor signs in and creates a new device-local record if appropriate. |
| Browser remembered-password record | AES-GCM ciphertext and IV in the same IndexedDB store | Supports Admin-password autofill without storing plaintext in local storage. | Removed together with the device key. Changing the Admin password updates the remembered record only when the remember option remains enabled. |

### Public identifiers that are not secrets

- PayPal browser client ID and hosted-button ID in `pages/giving.html`.
- Spotify track, playlist, album, and artist IDs.
- GitHub repository owner/name/branch and workbook path.
- Cloudflare Worker name, route, compatibility date, and allowed origin.
- Encryption salts, IVs, ciphertext, wrapped key, and SHA-256 fingerprint in the encrypted payload.
- Example passwords and `test-github-token` in Worker tests; these are fixtures, not production credentials.

### Account access that must also be handed over

The repository does not contain the credentials for:

- the GitHub owner/repository administration account;
- the Cloudflare account and zone for `joshbeyondborders.org`;
- the domain registrar;
- the PayPal account/hosted button that receives donations;
- Spotify, social, Canva press-kit, or Linktree accounts.

Transfer those through each service's team/role system where possible, not by sharing a personal password. Record MFA recovery ownership separately and securely.

## 9. Local development

### Static site

There is no frontend install or build. Serve the repository root over HTTP; using `file://` can break fetch-based giving and Admin behavior.

One simple option, if Python is installed:

```text
python -m http.server 8000
```

Then visit:

```text
http://localhost:8000/
http://localhost:8000/pages/giving.html
http://localhost:8000/admin/
```

On localhost, the Admin Portal loads the committed static encrypted payload. Password changes are intentionally disabled locally and must be performed on the live site.

### Worker

From `worker/`:

```text
pnpm install
pnpm test
pnpm run check
```

`pnpm test` runs the Vitest Worker suite. `pnpm run check` runs both TypeScript checks and a Wrangler dry-run; it does not deploy.

For local Worker development, do not place a production token in source. The repository ignores `.env` and `.env.*`, but it does not currently ignore `.dev.vars`. Prefer an ignored local environment file or a temporary environment variable, use a development-only least-privilege token, and verify with `git status` before every commit.

After changing Worker bindings, regenerate types with:

```text
pnpm run types
```

## 10. Deployment and release

### Static site

The live site is the Git-integrated Cloudflare Pages project `joshbeyondborders`.

| Setting | Current value |
| --- | --- |
| Production branch | `main` |
| Git repository | `kernbrent/JoshBeyondBorders` |
| Pages hostname | `joshbeyondborders.pages.dev` |
| Production custom domains | `joshbeyondborders.org`, `www.joshbeyondborders.org`, and `joshbeyondborders.hopesojourns.com` |
| Frontend build | No build step is represented in this repository; the repository's static files are the deployable output. Confirm the dashboard's build/output fields before changing them. |

There is also a Git-integrated Cloudflare Pages project named `joshbeyondborders-test`. Its production branch is `test-design` and its hostname is `joshbeyondborders-test.pages.dev`. Use it for design validation without changing the production project, but remember that its `test-design` branch can drift behind `main`.

No GitHub Actions workflow, `CNAME`, or Pages manifest is committed because the Git connection and custom domains live in Cloudflare. A new commit on the configured branch normally creates a Pages deployment. Always compare the live deployment source commit with the intended Git commit after release; do not assume a push succeeded.

During formal account handoff, record the Cloudflare account owner, build/output settings, DNS records, rollback procedure, retention, analytics, and alert recipients in the team's private operations system.

### Worker

The Worker has no committed deployment workflow and is deployed manually from `worker/`:

```text
pnpm test
pnpm run check
pnpm exec wrangler deploy
```

The final command changes production and must be run only by an authorized maintainer after review. `wrangler.jsonc` enables Worker logs and traces; use Cloudflare observability when investigating production API failures.

### Recommended release checklist

1. Confirm `git status` contains only intended changes.
2. Serve and inspect every changed page at desktop and mobile widths.
3. Check navigation, image paths, console errors, and external links.
4. If giving data changed, test both the public meter and Admin workbook decryption.
5. Run `pnpm test` and `pnpm run check` for Worker-related changes.
6. Review for unencrypted donor files and accidental secrets.
7. Review and commit; push only when explicitly approved for release.
8. Verify the live site and, if relevant, both Admin API endpoints.
9. Confirm donation and Spotify embeds without completing a real payment.

## 11. Common maintenance tasks

### Edit page copy

Edit the appropriate HTML file directly. If navigation or footer markup changes, repeat the change across every public HTML page. Keep headings, labels, alt text, and ARIA attributes intact.

### Add or replace an image

Use `assets/` for brand/decorative assets and `images/` for content photography and giving graphics. Existing campaign images use `beyond<YYYYMMDD><sequence>` naming. Optimize image dimensions and file size before release, preserve meaningful alt text, and update every reference.

### Change the fundraising goal

Update all of the following together:

- `GIVING_GOAL` in `admin/admin.js`;
- `goal` in `data/giving-progress.json`;
- any visible goal copy or fallback values in `pages/giving.html`;
- tests or documentation that assert the old value, if added later.

Then prepare a fresh pair of giving files so future Admin downloads use the new goal.

### Change the donation destination or button

The PayPal browser client ID, container ID, and `hostedButtonId` are in `pages/giving.html`. Make the corresponding change in the authorized PayPal account first, then update the HTML identifiers and verify the rendered recipient/destination before release. Never place a PayPal secret or private API credential in HTML.

### Change Spotify content

Track IDs are used in `index.html`, `pages/listen.html`, and the allowlist in legacy `pages/player.html`. Playlist, artist, and album URIs are in `pages/listen.html`. Keep button labels and accessible names synchronized with IDs.

### Change the Admin password

Use the live Admin Portal. A successful change creates a Git commit through the Worker. Pull/reconcile that commit before making further local changes so the encrypted payload is not accidentally overwritten with an older password wrapper.

### Rotate the GitHub token

Create a fine-grained replacement limited to this repository and **Contents: Read and write**, set `GITHUB_TOKEN` in Cloudflare from the Worker directory, test the live encrypted-workbook read and a controlled password change if appropriate, then revoke the old token. Do not put the token in `wrangler.jsonc`.

## 12. Failure modes and recovery

| Symptom | Likely cause | Response |
| --- | --- | --- |
| Giving meter shows fallback text | Missing/invalid `data/giving-progress.json`, wrong relative path, or hosting/cache problem | Open the JSON URL directly, validate numeric `raised`/`goal`, and check browser console/network output. |
| Admin login works but password change fails | Worker unavailable, GitHub token expired/missing, origin mismatch, GitHub conflict, or stale local payload | Check Worker logs, validate the secret, pull the latest `main`, reload, and retry. |
| Admin API read fails but login still works | The browser has fallen back to the committed static encrypted file | Restore the Worker/GitHub integration before attempting a password change. |
| Password changed elsewhere | GitHub file SHA conflict from simultaneous/stale updates | Pull/reload the latest payload and retry. Do not overwrite the encrypted file with an older copy. |
| Admin password is lost | There is no current recovery access in the payload | Recover an authorized unencrypted workbook backup or rebuild a new encrypted payload. The ciphertext cannot be decrypted without the password-wrapped data key. |
| Worker deploy reports a missing secret | `GITHUB_TOKEN` is absent from the target Cloudflare environment | Set the encrypted secret in the correct Cloudflare account/environment; never add it to config. |
| Report preparation cannot find the total | The workbook does not contain exactly one yellow numeric cell in column I | Correct the workbook formatting and retry. |
| Styling appears stale | Cache-busting query string was not updated everywhere or the static release has not propagated | Update all asset version references, confirm deployment, and hard-refresh during diagnosis. |

## 13. Current verification and known gaps

Verified on August 17, 2026:

- local branch `main` matched `origin/main` at commit `6980d67` before this guide was added;
- the working tree was clean before documentation edits;
- Worker tests passed: 1 test file, 8 tests;
- TypeScript checks and Wrangler deployment dry-run passed;
- the production home page returned HTTP 200 through Cloudflare;
- Cloudflare Pages project `joshbeyondborders` was Git-connected to production branch `main`, and its latest production deployment matched commit `6980d67`;
- Cloudflare Pages test project `joshbeyondborders-test` was Git-connected to branch `test-design`;
- the deployed Worker listed exactly one secret name, `GITHUB_TOKEN` (its value was not read and is not retrievable through this guide);
- the production encrypted-workbook endpoint returned HTTP 200, payload version 2, the expected encryption algorithm and password-iteration count, and `Cache-Control: no-store`.

Known handoff gaps that cannot be answered from source code:

- Cloudflare account owner, detailed build/output settings, and alert recipients;
- domain registrar and renewal owner/date;
- the exact Pages rollback and retention process agreed for this site;
- GitHub PAT owner and expiration date;
- PayPal hosted-button account owner and settlement/reconciliation contacts;
- designated custodians for the Admin password and unencrypted recovery backups;
- monitoring/alert recipients and incident contacts.

Fill these gaps in a private operations record. Do not add account passwords, token values, MFA recovery codes, donor data, or other live secrets to this document.
