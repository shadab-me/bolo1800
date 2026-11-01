# Bolo1800 — Profit Plan (1800 numbers only)

Prices change. Recheck every number marked *quote needed* with a written quote before relying on it.
Researched 31 Oct 2026.

## 1. What we sell

The panel now sells the same offer as the competitor (CallerDesk, resold by the WhatsApp seller):

- **₹5,000 for 3,000 minutes over 3 months**, on a real 1800 toll-free number (`PACKAGE` in `server.js`).
- **₹1/min after the bundle runs out.** Calls keep ringing through as "extra minutes" until the client has run up `OVERAGE_CAP_MIN` (default 500, so at most ₹500 is owed). The admin collects them with the **Collect** button on the client row. Overage can be switched off per client.
- **Top-ups at ₹1/min** (500 / 1,000 / 2,000 minutes) for clients who want minutes in advance.

## 2. Where the 1800 numbers come from

| Provider | 1800 rental | Per minute | Works with the panel? | Notes |
|---|---|---|---|---|
| **Vobiz** (start here) | about ₹999/month via Edesy; direct price *quote needed* | about ₹0.50 per leg, so about ₹1.00 for a forwarded call *quote needed* | **Yes.** Same XML and callbacks as Plivo; set `PROVIDER=vobiz` | Indian CPaaS. Edesy resells it. |
| Edesy | ₹999/month, no setup fee, no contract | ₹0.50/min SIP, 60-second pulse | Only if it exposes an Answer URL; ask | Resells Vobiz. |
| Tata Tele Business (Smartflo) | about ₹500 per channel including 400 min, then about ₹0.50/min *quote needed* | — | Has an API; a webhook adapter would be needed | Sales: 1800 266 1800. Best Phase 2 option. |
| Jio Business toll-free | no public price *quote needed* | per-second billing | No public API; forwarding only | See section 5. |
| Exotel | ₹1,500–3,000/month | higher | Different webhook format | Too expensive to match ₹5,000. |
| Plivo | **no 1800 numbers in India** | — | — | Only 080/022, so it is out. |

## 3. Phase 1: start now and accept the early loss

Cost per client per quarter: 3 × ₹999 rental = ₹2,997, plus about ₹1.00 for every minute used.

| Average client uses | Cost per client | Result per client (₹5,000) | **50 clients, per month** |
|---|---|---|---|
| 600 min (20%) | ₹3,597 | +₹1,403 | **+₹23,400** |
| 900 min (30%) | ₹3,897 | +₹1,103 | **+₹18,400** |
| 1,500 min (50%) | ₹4,497 | +₹503 | **+₹8,400** |
| 2,100 min (70%) | ₹5,097 | −₹97 | −₹1,600 |
| 3,000 min (all) | ₹5,997 | −₹997 | −₹16,600 |

- **Break-even is about 2,000 minutes per client per quarter.** Most small businesses use far less. Breakage (unused minutes) is how the competitor makes money too.
- **Extra minutes at ₹1 roughly break even in Phase 1.** They only make money in Phase 2.
- **Every call is billed per started minute** (`Math.ceil`), so a 61-second call counts as 2 minutes. This adds a small margin on every call.
- **GST.** If the ₹5,000 includes 18% GST, you keep ₹4,237. Take ₹763 off every result above.
- **Fixed costs.** A VPS costs about ₹500–1,500/month.

**Loss budget.** The worst case is about ₹1,000 per client per quarter, and only if every client uses everything. With 10 clients, that is about ₹10,000 per quarter. Watch "Unused minutes" in the admin panel. If average use goes above about 60%, move to Phase 2 sooner.

## 4. Phase 2: at about 20–50 clients, cut the cost per minute

With 20 or more numbers you have volume to negotiate. Do one or more of these:

1. **Sign a toll-free contract with an operator** (Tata Smartflo, Airtel Business or Jio Business). Ask for: rental per number, per-minute cost by caller type, pulse length, minimum commitment, and whether they give an Answer URL/webhook or a SIP trunk.
2. **Answer in a browser or app instead of forwarding to a mobile.** This removes the second paid leg and roughly halves the cost per minute. It needs a softphone feature in the panel, which is not built yet.
3. **Run your own SIP trunk with FreeSWITCH** behind the same webhook contract (`SETUP.md`, Phase 2). The panel, billing and dashboards stay the same.

Target cost after Phase 2 (*quote needed*): about ₹500/month rental and about ₹0.50/min.

| Average client uses | Cost per client | Result per client | **50 clients, per month** |
|---|---|---|---|
| 600 min (20%) | ₹1,800 | +₹3,200 | **+₹53,300** |
| 1,500 min (50%) | ₹2,250 | +₹2,750 | **+₹45,800** |
| 3,000 min (all) | ₹3,000 | +₹2,000 | **+₹33,300** |

On these costs, extra minutes earn about ₹0.50 each, and even a client who uses everything is profitable.

**Extra levers:** annual prepaid plans (cash upfront), a second number per client, IVR menus, and WhatsApp/SMS missed-call alerts.

## 5. Can we use our Jio number?

- **A Jio mobile number cannot be turned into an 1800 number.** Toll-free numbers are a separate series that only a licensed operator issues.
- **Do not put Jio SIMs in a gateway or SIM-box to carry clients' calls.** This is illegal in India. DoT and police are actively raiding these setups: the CBI and state cyber cells have busted SIM-box networks, and DoT has dismantled dozens of centres. Consumer SIMs also forbid commercial use, and the numbers get blocked.
- **What is legal:**
  - **Jio Business toll-free.** Jio sells 1800 numbers to businesses. Calls can land on any mobile or landline, routing can follow region, time or load, and billing is per second. There is no public price or API, so ask for a quote using their callback form.
  - **Use a Jio mobile as the destination.** The client's 1800 number (from Vobiz or another provider) forwards to their Jio mobile. That already works in the panel: put the Jio number in "Forward to".

## 6. Licensing (check before charging anyone)

- The old OSP registration for call centres was removed in the 2020–2021 reforms.
- Toll-free service itself must come from a licensed operator (a TSP or UL-VNO). The safe structure is to **resell a licensed provider's service** (Vobiz, Tata, Jio) under your brand, not to run your own telecom network.
- Ask a telecom lawyer or CA to confirm this before you charge clients. Nothing here is legal advice.
- Every provider needs business KYC: GST, Udyam or a Certificate of Incorporation. PAN alone is usually rejected.

## 7. What to do, in order

1. **Now:** open a Vobiz account (or Edesy if Vobiz is slow), complete KYC, and rent one 1800 number. Put it on the VPS and make a real test call.
2. **First clients:** sell ₹5,000 / 3,000 minutes, then ₹1/min. Set `COST_PER_MIN` and each number's monthly cost to the real figures so the admin profit table is correct.
3. **At 10–20 clients:** get written quotes from Tata Smartflo, Airtel Business and Jio Business.
4. **At 20–50 clients:** move to the cheapest contract and build the softphone so calls need only one leg.

## Sources

- Vobiz XML and callbacks (same as Plivo): https://raw.githubusercontent.com/vobiz-ai/Vobiz-MCP-Server/66e79574cb2188aa7681af4f92e782041ae2f1ae/skills/vobiz-voice-xml/SKILL.md and https://docs.dograh.com/integrations/telephony/vobiz
- Vobiz listing and price range: https://www.capterra.com/p/10054753/Vobiz/
- Edesy toll-free and SIP prices: https://edesy.in/toll-free-number/vs/plivo and https://edesy.in/sip-trunking
- Edesy on Vobiz: https://edesy.in/ai-voice-agent/providers/vobiz
- Tata toll-free: https://www.tatatelebusiness.com/connectivity/toll-free-services and https://www.tatatelebusiness.com/articles/1800-toll-free-number/
- Tata Smartflo pricing summary: https://www.saascounter.com/products/ttbs-smartflo
- Jio Business toll-free: https://www.jio.com/business/services/voice-and-collaboration/toll-free-number/
- Exotel pricing: https://developer.exotel.com/docs/billing/pricing-model
- Plivo India numbers: https://www.plivo.com/virtual-phone-numbers/pricing/in/
- OSP reforms: https://trilegal.com/knowledge-repository/the-osp-framework-gets-a-progressive-overhaul/
- SIM-box enforcement: https://dailypioneer.com/technology/karnataka-cyber-command-busts-illegal-sim-box-network-in-bengaluru-four-arrested and https://superkalam.com/current-affairs/12-02-2026/how-cbi-busted-a-national-cyber-gang-that-used-20-986-illegal-sims-to-dupe-people-pg4-022f6398-ba76-4ebb-b60c-4aad302ba19e
- CallerDesk (no public pricing found): https://callerdesk.io/
