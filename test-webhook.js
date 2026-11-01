/**
 * Bolo1800 end-to-end test — drives the real HTTP API against a throwaway database.
 * Run: node test-webhook.js
 *
 * Covers: admin login, inventory, client onboarding, number assignment, inbound call XML,
 * billing on completion, carrier retry idempotency, top-up approval, suspension, webhook auth.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bolo1800-test-'));
process.env.WEBHOOK_TOKEN = 'test-webhook-token';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.HANGUP_GRACE_MS = '50';

const app = require('./server');

let base;
let passed = 0;

async function api(pathname, { token, body } = {}) {
  const res = await fetch(base + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Carriers post form-encoded bodies
async function webhook(name, params, token = process.env.WEBHOOK_TOKEN) {
  const res = await fetch(`${base}/api/webhook/${name}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  return { status: res.status, text: await res.text() };
}

async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

async function main() {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Let db.js finish creating tables and seeding the admin
  await new Promise(r => setTimeout(r, 500));

  let admin, client, clientId;
  const tollFree = '1800 200 9999';

  await step('admin logs in and is flagged as using the default password', async () => {
    const r = await api('/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.default_password, true);
    admin = r.data.token;
  });

  await step('client token cannot reach admin routes', async () => {
    const r = await api('/api/admin/stats');
    assert.equal(r.status, 401);
  });

  await step('add toll-free number to inventory (formatting is normalised)', async () => {
    const r = await api('/api/admin/number-pool/add', { token: admin, body: { phone_number: tollFree, number_type: '1800 Toll-Free', monthly_cost: 1200 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const pool = await api('/api/admin/number-pool', { token: admin });
    assert.equal(pool.data.available_numbers[0].phone_number, '18002009999');
  });

  await step('onboard client with 1000 min / 3 months / ₹5000', async () => {
    const r = await api('/api/admin/clients/create', { token: admin, body: {
      company_name: 'Acme Support <b>India</b>', username: 'acme', password: 'Password@123',
      phone: '+91 98765 43210', initial_minutes: 1000, expiry_months: 3, amount_paid: 5000
    } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const list = await api('/api/admin/clients', { token: admin });
    const c = list.data.clients.find(x => x.username === 'acme');
    assert.equal(c.minutes_balance, 1000);
    assert.equal(c.revenue, 5000);
    clientId = c.id;
  });

  await step('assign number with forwarding to two mobiles', async () => {
    const r = await api('/api/admin/clients/assign-number', { token: admin, body: {
      client_id: clientId, phone_number: '18002009999', label: 'Support', forward_to: '+91 98765 43210, 09811223344'
    } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });

  await step('client logs in and sees the number', async () => {
    const r = await api('/api/auth/login', { body: { username: 'acme', password: 'Password@123' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.default_password, false);
    client = r.data.token;
    const d = await api('/api/client/details', { token: client });
    assert.equal(d.data.numbers.length, 1);
    assert.equal(d.data.numbers[0].forward_to, '9876543210, 9811223344');
  });

  await step('client token is rejected on admin routes', async () => {
    const r = await api('/api/admin/clients', { token: client });
    assert.equal(r.status, 403);
  });

  await step('webhook without the token is refused', async () => {
    const r = await webhook('incoming', { To: '+9118002009999', From: '+919988776655', CallSid: 'X' }, 'wrong');
    assert.equal(r.status, 403);
  });

  await step('inbound call (dialed as +91 1800…) returns Dial XML capped at balance + extra-minute cap', async () => {
    const r = await webhook('incoming', { To: '+9118002009999', From: '+919988776655', CallSid: 'CA_TEST_1' });
    assert.equal(r.status, 200);
    assert.match(r.text, /<Dial [^>]*timeLimit="90000"/);
    assert.match(r.text, /<Number>\+919876543210<\/Number>/);
    assert.match(r.text, /<Number>\+919811223344<\/Number>/);
    assert.match(r.text, /call-complete\?token=test-webhook-token/);
  });

  await step('125 s call bills 2 tokens with 5s grace window (61s bills 1 token)', async () => {
    await webhook('call-complete', { CallSid: 'CA_TEST_1', DialCallDuration: 125, DialCallStatus: 'completed', RecordingUrl: 'https://rec.example/1.mp3' });
    const d = await api('/api/client/details', { token: client });
    assert.equal(d.data.user.minutes_balance, 998);
  });

  await step('carrier retry of the same callback does not bill twice', async () => {
    await webhook('call-complete', { CallSid: 'CA_TEST_1', DialCallDuration: 125, DialCallStatus: 'completed' });
    const d = await api('/api/client/details', { token: client });
    assert.equal(d.data.user.minutes_balance, 998);
  });

  await step('call log records the recording and rejects javascript: URLs', async () => {
    await webhook('incoming', { To: '18002009999', From: '9000000000', CallSid: 'CA_TEST_2' });
    await webhook('call-complete', { CallSid: 'CA_TEST_2', DialCallDuration: 30, RecordingUrl: 'javascript:alert(1)' });
    const { data } = await api('/api/client/cdr', { token: client });
    const byId = Object.fromEntries(data.logs.map(l => [l.call_sid, l]));
    assert.equal(byId.CA_TEST_1.recording_file, 'https://rec.example/1.mp3');
    assert.ok(!byId.CA_TEST_2.recording_file);
  });

  await step('client cannot invent a top-up price', async () => {
    const r = await api('/api/client/topup-request', { token: client, body: { plan_id: 'free', payment_ref: 'UTR123456' } });
    assert.equal(r.status, 400);
  });

  let requestId;
  await step('client requests a top-up; only one pending at a time', async () => {
    const r = await api('/api/client/topup-request', { token: client, body: { plan_id: 'starter', payment_ref: 'UTR123456' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const again = await api('/api/client/topup-request', { token: client, body: { plan_id: 'starter', payment_ref: 'UTR999999' } });
    assert.equal(again.status, 400);
    const list = await api('/api/admin/topup-requests', { token: admin });
    requestId = list.data.requests.find(x => x.status === 'pending').id;
  });

  await step('approving twice credits minutes only once', async () => {
    const before = (await api('/api/client/details', { token: client })).data.user.minutes_balance;
    const first = await api('/api/admin/topup-approve', { token: admin, body: { request_id: requestId, action: 'approve' } });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    await api('/api/admin/topup-approve', { token: admin, body: { request_id: requestId, action: 'approve' } });
    const after = (await api('/api/client/details', { token: client })).data.user.minutes_balance;
    const plan = (await api('/api/plans', { token: client })).data.plans.find(p => p.id === 'starter');
    assert.equal(after - before, plan.minutes);
  });

  await step('suspended client: calls are rejected and login is blocked', async () => {
    await api('/api/admin/clients/status', { token: admin, body: { client_id: clientId, status: 'suspended' } });
    const r = await webhook('incoming', { To: '18002009999', From: '9000000001', CallSid: 'CA_TEST_3' });
    assert.match(r.text, /<Hangup\/>/);
    assert.doesNotMatch(r.text, /<Dial/);
    const login = await api('/api/auth/login', { body: { username: 'acme', password: 'Password@123' } });
    assert.equal(login.status, 403);
  });

  await step('admin stats report revenue and a cost estimate', async () => {
    const { data } = await api('/api/admin/stats', { token: admin });
    assert.ok(data.revenue_all_time >= 5000);
    assert.equal(data.minutes_month, 3);
    assert.ok(data.est_cost_month > 0);
  });

  // ---- Plivo format (the default provider) ----
  await api('/api/admin/clients/status', { token: admin, body: { client_id: clientId, status: 'active' } });
  const balance = async () => (await api('/api/client/details', { token: client })).data.user.minutes_balance;

  await step('plivo: answer_url returns Record + Dial with dial-event and recording callbacks', async () => {
    const r = await webhook('incoming', { CallUUID: 'pl-1', From: '919988776655', To: '9118002009999', Direction: 'inbound', CallStatus: 'ringing' });
    assert.match(r.text, /<Record startOnDialAnswer="true" redirect="false"[^>]*recording\?token=/);
    assert.match(r.text, /<Dial [^>]*callbackUrl="[^"]*dial-event\?token=test-webhook-token"/);
    assert.match(r.text, /<Number>\+919811223344<\/Number>/);
    assert.doesNotMatch(r.text, /record="/);
  });

  await step('plivo: unanswered leg does not close the call; answered 61 s leg bills 1 token (under grace window)', async () => {
    const before = await balance();
    await webhook('dial-event', { DialAction: 'hangup', DialALegUUID: 'pl-1', DialBLegUUID: 'b1', DialBLegDuration: 0 });
    await webhook('dial-event', { DialAction: 'hangup', DialALegUUID: 'pl-1', DialBLegUUID: 'b2', DialBLegDuration: 61 });
    await webhook('dial-event', { DialAction: 'hangup', DialALegUUID: 'pl-1', DialBLegUUID: 'b2', DialBLegDuration: 61 });
    await webhook('call-complete', { CallUUID: 'pl-1', DialStatus: 'completed', DialALegUUID: 'pl-1' });
    assert.equal(before - await balance(), 1);
  });

  await step('plivo: recording callback attaches the file', async () => {
    await webhook('recording', { CallUUID: 'pl-1', RecordUrl: 'https://media.plivo.com/r/1.mp3', RecordingDuration: 61 });
    const { data } = await api('/api/client/cdr', { token: client });
    const row = data.logs.find(l => l.call_sid === 'pl-1');
    assert.equal(row.status, 'completed');
    assert.equal(row.recording_file, 'https://media.plivo.com/r/1.mp3');
  });

  await step('plivo: nobody answers -> no-answer, nothing billed', async () => {
    const before = await balance();
    await webhook('incoming', { CallUUID: 'pl-2', From: '919000000002', To: '18002009999' });
    await webhook('call-complete', { CallUUID: 'pl-2', DialStatus: 'timeout' });
    const { data } = await api('/api/client/cdr', { token: client });
    assert.equal(data.logs.find(l => l.call_sid === 'pl-2').status, 'no-answer');
    assert.equal(await balance(), before);
  });

  await step('plivo: rejected call uses <Speak>, not <Say>', async () => {
    const r = await webhook('incoming', { CallUUID: 'pl-3', From: '919000000003', To: '18001112222' });
    assert.match(r.text, /<Speak language="en-IN">/);
  });

  await step('usage series: 30 days, today holds the calls', async () => {
    const { data } = await api('/api/client/usage?days=30', { token: client });
    assert.equal(data.days.length, 30);
    const today = data.days.at(-1);
    assert.equal(today.answered, 3);
    assert.equal(today.missed, 1);
    assert.equal(today.minutes, 4);
    const adm = await api('/api/admin/usage?days=7', { token: admin });
    assert.equal(adm.data.days.length, 7);
    assert.ok(adm.data.days.at(-1).revenue >= 5000);
  });

  await step('plivo hangup_url: no double bill after dial-event; bills a call whose dial-event was lost', async () => {
    const before = await balance();
    await webhook('hangup', { CallUUID: 'pl-1', Duration: 75, BillDuration: 90, CallStatus: 'completed' });
    await webhook('incoming', { CallUUID: 'pl-4', From: '919000000004', To: '18002009999' });
    await webhook('hangup', { CallUUID: 'pl-4', Duration: 130, BillDuration: 150, CallStatus: 'completed' });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(before - await balance(), 3);
    const { data } = await api('/api/client/cdr', { token: client });
    assert.equal(data.logs.find(l => l.call_sid === 'pl-4').status, 'completed');
  });

  // ---- Extra minutes after the bundle (overage), on a Vobiz-style callback ----
  let small, smallId;
  await step('overage: small client onboarded with 2 minutes', async () => {
    await api('/api/admin/number-pool/add', { token: admin, body: { phone_number: '18003334444', number_type: '1800 Toll-Free' } });
    await api('/api/admin/clients/create', { token: admin, body: {
      company_name: 'Tiny Co', username: 'tiny', password: 'Password@123', initial_minutes: 2, expiry_months: 3, amount_paid: 0
    } });
    smallId = (await api('/api/admin/clients', { token: admin })).data.clients.find(x => x.username === 'tiny').id;
    await api('/api/admin/clients/assign-number', { token: admin, body: { client_id: smallId, phone_number: '18003334444', forward_to: '9811000000' } });
    small = (await api('/api/auth/login', { body: { username: 'tiny', password: 'Password@123' } })).data.token;
  });

  await step('vobiz: Event=DialHangup bills; minutes past the bundle become overage', async () => {
    const r = await webhook('incoming', { CallUUID: 'vb-1', From: '919000000005', To: '18003334444' });
    assert.match(r.text, /timeLimit="30120"/); // (2 + 500 cap) × 60
    await webhook('dial-event', { Event: 'DialHangup', DialALegUUID: 'vb-1', DialBLegUUID: 'vb-1b', DialBLegDuration: 200 });
    const u = (await api('/api/client/details', { token: small })).data.user;
    assert.equal(u.minutes_balance, 0);
    assert.equal(u.overage_minutes, 2);
    const stats = (await api('/api/admin/stats', { token: admin })).data;
    assert.equal(stats.overage_minutes, 2);
  });

  await step('overage: the next call is capped at what is left of the cap', async () => {
    const r = await webhook('incoming', { CallUUID: 'vb-2', From: '919000000006', To: '18003334444' });
    assert.match(r.text, /timeLimit="29880"/); // (500 − 2) × 60
  });

  await step('overage switched off: a client with 0 minutes is rejected', async () => {
    await api('/api/admin/clients/overage', { token: admin, body: { client_id: smallId, enabled: false } });
    const r = await webhook('incoming', { CallUUID: 'vb-3', From: '919000000007', To: '18003334444' });
    assert.doesNotMatch(r.text, /<Dial/);
    await api('/api/admin/clients/overage', { token: admin, body: { client_id: smallId, enabled: true } });
  });

  await step('collecting overage clears it once and records the revenue', async () => {
    const first = await api('/api/admin/clients/settle-overage', { token: admin, body: { client_id: smallId, payment_ref: 'UTR42' } });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const again = await api('/api/admin/clients/settle-overage', { token: admin, body: { client_id: smallId } });
    assert.equal(again.status, 400);
    const c = (await api('/api/admin/clients', { token: admin })).data.clients.find(x => x.id === smallId);
    assert.equal(c.overage_minutes, 0);
    assert.equal(c.revenue, 2);
  });

  await step('exotel: GET query request returns HTTP 200 with JSON destination numbers', async () => {
    // Exotel Programmable Connect dynamic URL sends GET with CallSid, CallFrom, CallTo
    const qs = 'CallSid=exo_123&CallFrom=919876543210&CallTo=18002009999&Direction=inbound';
    const res = await fetch(`${base}/api/webhook/incoming?token=test-webhook-token&${qs}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const data = await res.json();
    assert.ok(data.destination);
    assert.ok(Array.isArray(data.destination.numbers));
    assert.deepEqual(data.destination.numbers, ['+919876543210', '+919811223344']);

    // Also support format=text
    const textRes = await fetch(`${base}/api/webhook/incoming?token=test-webhook-token&${qs}&format=text`);
    assert.equal(textRes.status, 200);
    assert.match(textRes.headers.get('content-type'), /text\/plain/);
    const text = await textRes.text();
    assert.match(text, /\+919876543210/);

    // Exotel call-complete returns 200 OK
    const done = await fetch(`${base}/api/webhook/call-complete?token=test-webhook-token&CallSid=exo_123&DialCallDuration=61&DialCallStatus=completed`);
    assert.equal(done.status, 200);
    const doneText = await done.text();
    assert.equal(doneText, 'OK');
  });

  server.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}

main().catch(err => {
  console.error(`\nFAILED after ${passed} checks:\n`, err);
  process.exit(1);
});
