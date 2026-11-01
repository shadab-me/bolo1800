# Bolo1800 - Multi-Tenant Voice Management & Call Diversion System (India)

Lightweight, production-ready voice management and call diversion panel accessible directly via IP (e.g. `http://<YOUR_SERVER_IP>/login`).

---

## 1. Quick Deploy on Ubuntu VPS (Hetzner / Contabo / etc.)

On your Ubuntu server, run:

```bash
# 1. Install Docker & Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh

# 2. Upload / Clone the bolo1800 directory to your server
cd /path/to/bolo1800

# 3. Point your domain's A record at this server, then run the deploy script.
#    It asks for the domain, writes .env with random secrets, and starts the app behind Caddy (HTTPS).
./deploy.sh
```

The panel is served on **https://<your-domain>**. Caddy handles ports 80 and 443 and the certificate.

---

## 2. Portal URLs & Default Credentials

* **Login URL:** `https://<your-domain>/login`
* **Default Super Admin:**
  * **Username:** `admin`
  * **Password:** the `ADMIN_PASSWORD` that `deploy.sh` wrote to `.env`

---

## 3. How the Business Flow Works

### Onboarding a Client (Charging ₹5,000 upfront)
1. You collect **₹5,000** offline via UPI or Bank transfer from the client for **1,000 minutes (3 months validity)**.
2. Log in as Super Admin (`/admin`) and click **+ Onboard New Client**.
3. Enter their company name, choose a username & password, and the system automatically pre-loads **1,000 minutes** with an expiry date **3 months** from today.
4. Click **+ Assign 1800 Number** to attach the toll-free number you got from Exotel / Tata to their account, pointing to their initial mobile number.
5. Send the client the link: `http://<YOUR_SERVER_IP>/login` with their username & password.

### Client Experience
* The client logs into their dashboard.
* They see their remaining balance: e.g. **1,000 Minutes**.
* They see their assigned 1800 number.
* They can update their forwarding mobile number anytime in 1 click.
* They can see all incoming calls in real-time with an **audio player** to listen to or download call recordings.

### Recharging (+1,000 Minutes)
When a client exhausts their minutes or renews after 3 months:
* They transfer you ₹5,000.
* In your Admin panel, click **+1,000 Mins (₹5k Package)** next to their name.
* The system adds 1,000 minutes and automatically extends their expiry date by another 3 months.

---

## 4. Connecting Exotel / Tata Smartflo / Airtel IQ Webhook

In your telecom provider's portal (e.g. Exotel App Bazaar or Tata Smartflo flow):
* Set the **Incoming Call Webhook URL** to:
  `http://<YOUR_SERVER_IP>/api/webhook/incoming`
* Set the **Call Completion & Recording Webhook** to:
  `http://<YOUR_SERVER_IP>/api/webhook/call-complete`

When an incoming call hits your 1800 number:
1. The server checks if the client has active minutes (> 0).
2. If balance > 0, it tells the carrier to bridge the call to the client's forwarding mobile and record the call.
3. When the call finishes, the carrier notifies the webhook with duration & recording audio URL.
4. The server rounds the duration to minutes, deducts it from the client's balance, and logs the CDR with the recording link.
