# Process Watcher Email Relay

Cloudflare Worker used by Process Watcher to verify recipient addresses and deliver completion emails through Resend.

## Security model

- `RESEND_API_KEY` and `TOKEN_SIGNING_SECRET` are Cloudflare secrets and never ship in the VSIX.
- Verification codes expire after 10 minutes and allow at most five attempts.
- Verification and notification endpoints are rate limited in D1.
- A global outbound limit protects the Resend account from unbounded public usage.
- A verified installation receives a signed one-year token. VS Code stores it in `SecretStorage`.
- A token can send only to the email address embedded in that token.
- Unsubscribe links use purpose-limited signed tokens and require confirmation before changing state.
- D1 stores only HMAC-derived recipient and IP identifiers. Explicit verification removes a recipient's suppression.

## Deploy

1. Authenticate Wrangler:

   ```powershell
   npx.cmd wrangler login
   ```

2. Create the database:

   ```powershell
   npx.cmd wrangler d1 create process-watcher-email
   ```

3. Copy the example configuration to the ignored production file:

   ```powershell
   Copy-Item wrangler.example.jsonc wrangler.production.jsonc
   ```

4. Copy the returned `database_id` into `wrangler.production.jsonc`. Add a custom domain under `routes` if desired.

5. Set `FROM_EMAIL` in `wrangler.production.jsonc` to a sender on a domain verified by Resend. For an initial account-owner-only test, Resend's `onboarding@resend.dev` sender can be used.

6. Apply migrations:

   ```powershell
   npm.cmd run db:migrate:remote
   ```

7. Add secrets directly from your terminal. Never paste them into source or chat:

   ```powershell
   npx.cmd wrangler secret put RESEND_API_KEY --config wrangler.production.jsonc
   npx.cmd wrangler secret put TOKEN_SIGNING_SECRET --config wrangler.production.jsonc
   ```

   For `TOKEN_SIGNING_SECRET`, generate a random value locally, then paste it into Wrangler's hidden prompt:

   ```powershell
   $bytes = New-Object byte[] 32
   $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
   $rng.GetBytes($bytes)
   [Convert]::ToBase64String($bytes)
   $rng.Dispose()
   ```

8. Deploy:

   ```powershell
   npm.cmd run deploy
   ```

9. Copy the resulting Worker URL into `EMAIL_RELAY_URL` in `src/emailNotifications.ts`, then rebuild the extension.

The current production relay is `https://relay.processwatcher.dev`; `GET /health` should return `{ "ok": true }`.

## Endpoints

- `GET /health`
- `POST /v1/email/request-code` with `{ "email": "user@example.com" }`
- `POST /v1/email/verify` with `{ "email": "user@example.com", "code": "123456" }`
- `POST /v1/email/notify` with a bearer token and process completion details
- `GET /v1/email/unsubscribe?token=...` to show the confirmation page
- `POST /v1/email/unsubscribe` to suppress a verified recipient
