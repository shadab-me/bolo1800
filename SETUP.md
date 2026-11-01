# Bolo1800 — going live with 1800 numbers

This is the checklist for taking Bolo1800 from a laptop to real 1800 calls. `README.md` covers the Docker deploy itself; this file covers what has to be true around it.

## How one call flows

```
Caller dials 1800 xxx xxxx
  → Indian operator routes the toll-free number to Vobiz (or Plivo)
  → The provider requests the Application's answer_url
      POST https://<your-domain>/api/webhook/incoming?token=<WEBHOOK_TOKEN>
  → Bolo1800 checks the client's balance and expiry, then returns XML:
      <Record startOnDialAnswer="true" …/>   (only if recording is on for that number)
      <Dial callbackUrl=…/dial-event action=…/call-complete> the team's mobiles </Dial>
  → All forwarding mobiles ring at once; the first to pick up talks
  → /api/webhook/dial-event     one 'hangup' event per leg; the leg with a duration is billed (once)
  → /api/webhook/call-complete  DialStatus for calls nobody answered (busy / no-answer / missed)
  → /api/webhook/recording      RecordUrl saved against the call
```

When the bundle runs out, calls keep going as **extra minutes** (₹`OVERAGE_RATE`/min) until the client has run up `OVERAGE_CAP_MIN`; the admin collects them with the **Collect** button on the client row. If extra minutes are switched off for that client, the cap is reached, or the package has expired, `/incoming` replies with a spoken "currently unavailable" message and hangs up.

## What you need

1. **A VPS with a domain and HTTPS.** The provider must reach the webhooks over the public internet. Any small Ubuntu box works; `docker-compose.yml` already runs Caddy, which gets the Let's Encrypt certificate for `DOMAIN` by itself. Point the domain's A record at the VPS, then run `./deploy.sh`.
2. **A Vobiz account with KYC completed** (vobiz.ai). Vobiz is an Indian CPaaS that rents 1800 numbers and drives calls with the same XML as Plivo, so the existing adapter works unchanged; set `PROVIDER=vobiz`. Before paying, get in writing: the 1800 rental, the per-minute rate for inbound 1800 plus the forwarded mobile leg, the pulse length, and that the number can use an Answer URL. Plivo itself has no 1800 numbers in India (checked 31 Oct 2026). Any provider that posts Plivo-style or Twilio-style webhooks (`CallSid`) works too.
3. **One 1800 number per client**, rented on that account.
4. **An Application** (Vobiz and Plivo both call it that) with:
   - Answer URL: `https://<your-domain>/api/webhook/incoming?token=<WEBHOOK_TOKEN>` (method POST)
   - Hangup URL: `https://<your-domain>/api/webhook/hangup?token=<WEBHOOK_TOKEN>` (method POST). This is the billing safety net when a Dial callback is lost.
   - The toll-free number attached to this Application
5. **Environment variables.** Set these in `.env`. `deploy.sh` writes it with random secrets, and `.env.example` lists every variable.

| Variable | What it is | Default if unset |
|---|---|---|
| `PROVIDER` | `vobiz`, `plivo` or `twilio`; used only when a webhook doesn't identify itself | `plivo` |
| `PUBLIC_URL` | `https://<your-domain>`; used to build the callback URLs inside the XML | the request's own host |
| `WEBHOOK_TOKEN` | long random string, also included in the answer_url | empty: **webhooks are open, so anyone can fake calls** |
| `JWT_SECRET` | long random string for login tokens | a built-in default: **change it** |
| `UPI_ID` | your UPI ID (clients no longer see a payment screen; top-ups are added by admin) | `bolo1800@upi` |
| `COST_PER_MIN` | what you pay per forwarded minute, both legs (₹), used for the admin margin chart | `1.00` |
| `OVERAGE_RATE` | what clients pay per extra minute after the bundle (₹) | `1` |
| `OVERAGE_CAP_MIN` | most extra minutes a client may run up before calls stop | `500` |
| `PORT` / `DATA_DIR` | already set in `docker-compose.yml` | `3000` / `./data` |

With `NODE_ENV=production`, the server **refuses to start** if `JWT_SECRET`, `WEBHOOK_TOKEN` or `PUBLIC_URL` is missing, or if the admin password is still `admin123`. Set `ADMIN_PASSWORD` before the first run. Outside production these are only warnings.

6. **Admin login.** The username is `admin` and the password is `ADMIN_PASSWORD` from `.env`. It is used only when the database is first created; change it later with the key icon in the header.

## Test before giving the number to a client

```bash
node test-webhook.js
```

This replays Plivo's and Vobiz's webhook sequence against a throwaway server and data folder, then checks billing, missed calls, recordings and extra-minute billing. Then make one real call to the number and confirm it appears in the client's dashboard with the right duration.

## Phase 2: around 50 clients

When per-minute charges start to hurt, replace the provider with a SIP trunk from an Indian operator and route it through your own FreeSWITCH. Keep the same webhook contract (`/incoming` returns the dial plan; hangup events bill), so the panel, billing and dashboards stay the same. Only the adapter in front of them changes.

## Caveats (open decisions, not code changes)

- **Licensing.** Reselling toll-free numbers and minutes in India may need DoT registration (for example a UL-VNO or OSP category, depending on how it's structured). Ask a CA or a telecom lawyer before charging clients. Nothing here has been checked legally.
- **The package loses money only at full use. This is your call.** The ₹5,000 package now matches the competitor: 3,000 minutes over 3 months, then ₹1/min. At about ₹999/month rental and ₹1/min cost, a client who uses all 3,000 minutes costs ₹5,997, about **₹1,000 lost**; break-even is about 2,000 minutes. See `PROFIT-PLAN.md` for the 50-client plan. The admin "Plan profitability" table shows this live once `COST_PER_MIN` and each number's monthly cost are set correctly.
- **Hangup fallback (done).** `/api/webhook/hangup` waits `HANGUP_GRACE_MS` (15 s) for the Dial callbacks. It then bills from the caller leg's `Duration`, only if the call is still unbilled. That duration includes ring time, so a call billed this way can be overstated by up to the ring timeout.
- **Back up `data/`.** It holds the SQLite database and the recordings. `backup.sh` exists. Schedule it with cron and copy the output somewhere off the VPS.
