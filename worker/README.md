# Admin password update service

This Cloudflare Worker gives the static Admin page one protected write action: changing the Admin password.

The password is never stored or sent to the Worker. GitHub contains only the encrypted workbook, a password-wrapped encryption key, and a one-way SHA-256 fingerprint of that random workbook key in `admin/resources/giving-workbook.enc.json`.

## One-time setup

1. In GitHub, create a fine-grained personal access token restricted to the `kernbrent/JoshBeyondBorders` repository.
2. Give the token only **Contents: Read and write** permission. It does not need workflow, administration, or account permissions.
3. Sign in to the Cloudflare account that manages `joshbeyondborders.org`:

   ```text
   pnpm exec wrangler login
   ```

4. Save the GitHub token as an encrypted Worker secret:

   ```text
   pnpm exec wrangler secret put GITHUB_TOKEN
   ```

5. Validate and deploy the Worker:

   ```text
   pnpm test
   pnpm run check
   pnpm exec wrangler deploy
   ```

The route is limited to `joshbeyondborders.org/api/admin/*`. Deploy the Worker before publishing Admin page code that uses this API.

## Password-change behavior

1. Josh signs in normally, proving the current password by decrypting the workbook in his browser.
2. From Admin Resources, he selects **Change password**, enters the new password, and confirms it.
3. The browser creates a new encrypted password wrapper and sends it with the temporary random workbook key over HTTPS. Passwords and donor records never leave the browser.
4. The Worker hashes the key, verifies it using the stored fingerprint with a timing-safe comparison, immediately clears it, and commits only the encrypted password wrapper to GitHub.
5. The new password can be used immediately because Admin login reads the current encrypted file through the Worker.

The temporary workbook key is never logged or stored by the Worker. The GitHub token stays in Cloudflare's encrypted secret storage and is never included in the website, API responses, or Worker logs.
