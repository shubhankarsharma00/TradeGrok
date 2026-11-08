# Broker onboarding and verification

Connect your own Angel One account to TradeGrok for read-only account data and market prices. **Execution remains paper-only.**

The dashboard has the same four steps under **Broker connection > Broker setup guide**. The guide starts collapsed; select its heading to open it.

## Before you start

- Install Node.js 24 or newer, including npm.
- Run commands from the TradeGrok repository root.
- Keep credentials in your local `.env`, never in Cloudflare, Git, screenshots or chat.
- Examples below use port `3100`. If you use another port, replace it in `.env` and the relay's `LOCAL_RETURN_ORIGIN`. The UI guide generates these examples from the current browser address; this document and configuration templates do not update automatically.

## 1. Set up an Angel One account

1. Open [Angel One](https://www.angelone.in/) or its official app and choose **Open Demat Account**. Skip this step if your account is already active.
2. Verify your mobile number and email. Prepare PAN, Aadhaar or accepted address proof, and bank details/proof. Complete the broker's KYC, video verification and e-sign prompts.
3. Wait for approval, confirm you can sign in, and keep your client ID available privately. Follow Angel One's current OTP/TOTP instructions if prompted.

Submit account documents only to Angel One. Current eligibility, required documents, charges and approval timing are controlled by the broker.

References: [Account-opening guide](https://www.angelone.in/knowledge-center/demat-account/how-to-open-demat-account) and [KYC requirements](https://www.angelone.in/knowledge-center/demat-account/how-to-complete-kyc-easily).

## 2. Set up Cloudflare HTTPS

Use the callback-only Worker included in this repository. Its `workers.dev` address supplies public HTTPS without a purchased domain or a tunnel to your dashboard.

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/). Open **Workers & Pages**, choose your `workers.dev` account subdomain, and use Workers Free.
2. Edit the existing `wrangler.jsonc`. Replace `YOUR_SUBDOMAIN` in `vars.PUBLIC_ORIGIN` and match the local return port:

   ```json
   {
     "PUBLIC_ORIGIN": "https://tradegrok-smartapi.YOUR_SUBDOMAIN.workers.dev",
     "LOCAL_RETURN_ORIGIN": "http://127.0.0.1:3100"
   }
   ```

   These entries belong inside `vars`. Keep `main` set to `server/cloudflare.js`. If you rename the Worker, update the hostname in `PUBLIC_ORIGIN` too.

3. Keep `observability.enabled`, `logpush` and `preview_urls` set to `false`. Before real login, disable Workers Logs, request tracing and request-capture integrations. Do not use dashboard live logs or `wrangler tail` during login: callbacks contain tokens.
4. Deploy from the repository root:

   ```sh
   npx wrangler@4 login
   npx wrangler@4 deploy --dry-run
   npx wrangler@4 deploy
   ```

   Use the actual deployed HTTPS hostname in the following steps. Deploy only the included relay, never the dashboard, `.env` or database.

5. Check the relay:

   ```sh
   curl --fail https://tradegrok-smartapi.YOUR_SUBDOMAIN.workers.dev/healthz
   ```

   Expected body: `{"status":"ok"}`. These routes must return HTTP `404`:

   ```sh
   curl --silent --output /dev/null --write-out '%{http_code}\n' \
     https://tradegrok-smartapi.YOUR_SUBDOMAIN.workers.dev/
   curl --silent --output /dev/null --write-out '%{http_code}\n' \
     https://tradegrok-smartapi.YOUR_SUBDOMAIN.workers.dev/api/state
   ```

Health verifies the relay is reachable and configured, **not** that Angel One login works. Never tunnel the local dashboard.

References: [Deployment guide](https://developers.cloudflare.com/workers/get-started/guide/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Free-plan limits](https://developers.cloudflare.com/workers/platform/pricing/).

## 3. Configure SmartAPI and your local environment

1. Sign in to [SmartAPI](https://smartapi.angelone.in/). Open **MyApps > Create App** and select the app access needed for account data, quotes and historical candles. Portal labels and app requirements can change; check the [current SmartAPI documentation](https://smartapi.angelone.in/docs).
2. Register this exact **Redirect URL**, replacing the hostname:

   ```text
   https://tradegrok-smartapi.YOUR_SUBDOMAIN.workers.dev/auth/smartapi/callback
   ```

   Do not register a loopback URL or `/healthz`. TradeGrok has no order-postback endpoint; do not use the login callback as a postback.

3. In guide step 3, enter your **HTTPS relay URL** and **SmartAPI API key**, then select **Save to local .env**. The URL is the origin only, without `/auth/smartapi/callback`.

   **The form saves directly to this computer's `.env`, not to a cloud service.** Its request goes only to the local TradeGrok server. The key is masked, never prefilled, never logged and never returned in dashboard state. Saving clears the entered key from the form. Angel One receives the key when you use its login/API.

   Saving preserves existing environment settings and writes with owner-only permissions. If `PORT` is missing, the current local server port is added. Restart TradeGrok to load the new settings; saving does not change the active connection or place an order. Environment variables set by your shell still take precedence over `.env`.

   **Prefer editing the file yourself?** Expand **Edit .env directly instead**. Create `.env` from `.env.example` only if it does not already exist, then edit it locally in the repository root:

   ```dotenv
   PORT=3100
   SMARTAPI_API_KEY=REPLACE_WITH_YOUR_OWN_API_KEY
   SMARTAPI_RELAY_ORIGIN=https://tradegrok-smartapi.YOUR_SUBDOMAIN.workers.dev
   ```

   Copy your app's **API key**, not its secret key. The relay origin has no callback path, query or explicit port. Do not add passwords, PINs or TOTP secrets.

   Keep `.env` private and out of Git. On macOS/Linux, run `chmod 600 .env`; on Windows, restrict file access to your user.

4. If your SmartAPI app requires a static-IP allowlist, use the local computer's public outbound IPv4. This command shows the current address only, not proof it is static:

   ```sh
   curl --fail --silent --show-error --ipv4 https://api.ipify.org
   ```

   Ask your ISP for a guaranteed static address if required. Cloudflare HTTPS does not provide a static outbound IP for local broker requests. Recheck the allowlist after network/VPN changes.

5. Stop and restart TradeGrok with `npm start`. Open [http://127.0.0.1:3100/#broker](http://127.0.0.1:3100/#broker), substituting your port.

In guide step 3, confirm **API KEY: LOADED** and **HTTPS RELAY: CONFIGURED**. These indicators detect local configuration only; they do not verify relay health, your registered Redirect URL or broker access.

## 4. Login and verify the connection

1. Select **Login with Angel One**, or **Click here to test Angel One login** in guide step 4. The guide's test action enables after the API key and HTTPS relay are configured.
2. Complete the official Angel One hosted login in the same browser within five minutes. Keep TradeGrok running and enter credentials/OTP/TOTP only on Angel One.
3. On return, confirm SmartAPI shows **callback received**. This means tokens arrived, not that account access has been verified.
4. Select **Verify read-only connection**. Successful verification changes the account status to **connected** and updates **Last verified**. The app requests actual holdings and cash-segment positions; an empty account can still verify successfully.
5. Check your holdings/positions snapshot and configured instruments' quotes. Do not infer success from absent prices: unsupported instruments, entitlements, authentication or quote failures need attention.

No broker order is sent during these checks. Paper bots must be started individually after reviewing their configuration and risk limits.

### Why the browser and address matter

The relay returns to `http://127.0.0.1:<PORT>`. Browsers treat `localhost` and `127.0.0.1` as different cookie hosts, even though both reach your computer. Start login from `127.0.0.1` so its temporary browser-bound cookie matches the return.

The pending login expires after five minutes and is held in server memory. Switching browsers/private windows, restarting the server or starting another login invalidates the earlier attempt.

## If verification fails

| What you see | What to check |
| --- | --- |
| API key or HTTPS relay missing | Edit local `.env`, replace placeholders, restart, then recheck guide step 3. |
| Relay health fails | Confirm the deployed hostname matches `PUBLIC_ORIGIN`, logging is disabled and the Worker variables are valid. Do not weaken origin checks. |
| Login rejected or callback incomplete | Match the SmartAPI Redirect URL and `.env` relay origin; match the relay's local return port. Start a fresh login from `127.0.0.1` in the same browser within five minutes. |
| Callback received, account not connected | Select Verify read-only connection. Read the expanded verification error if it fails; check app access, account authentication and any IP allowlist. |
| Connected but quotes unavailable | Check instrument configuration and the market-data error. TradeGrok does not substitute mock quotes or allow stale-data fills. |
| Session expired or restored after restart | Sessions end at midnight IST. Log in again after expiry; reverify account access after restoring a saved session. |

Routine information is collapsed on the broker page; verification failures remain expanded. Never paste returned tokens into the UI to bypass an error.

For the Azure alternative and additional deployment details, see the root [README setup instructions](../../README.md#set-up-angel-one-and-smartapi).
