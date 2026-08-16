# Admin password update service

This Cloudflare Worker gives the static Admin page one protected write action: changing the Admin password.

The password is never stored. GitHub contains only the encrypted workbook and the password-wrapped encryption key in `admin/resources/giving-workbook.enc.json`. The Worker verifies the current password, replaces that encrypted wrapper, and commits the updated JSON to `main`.

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

1. Josh opens the Admin login page and selects **Change password**.
2. He enters the current password, the new password, and the new password again.
3. The Worker confirms the current password and commits the new encrypted credential to GitHub.
4. The new password can be used immediately because Admin login reads the current encrypted file through the Worker.

The GitHub token stays in Cloudflare's encrypted secret storage and is never included in the website, API responses, or Worker logs.
