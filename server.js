require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { recordingsDir, run, get, all, normalizeNumber, normalizeList } = require('./db');

const app = express();
const PORT = process.env.PORT || 80;
const DEFAULT_SECRET = 'bolo1800_super_secret_key_2026';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
// Optional shared secret the carrier must send as ?token=... on webhook URLs
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const UPI_ID = process.env.UPI_ID || 'bolo1800@upi';
// Your blended telecom cost per billed token/minute (inbound toll-free leg + forward leg), in ₹.
// Set to ₹0.75 by default (wholesale cost: ₹0.70 - ₹0.80) to maximize your profit margin.
const COST_PER_MIN = parseFloat(process.env.COST_PER_MIN || '0.75');
// Which carrier XML to answer with when a request doesn't identify itself: 'plivo', 'vobiz' or 'twilio'.
// Vobiz uses Plivo's XML verbs and callback names, so both take the same path.
const PROVIDER = (process.env.PROVIDER || 'plivo').toLowerCase();
// Public https base URL the carrier reaches us on (behind a proxy req.protocol may say http)
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const IS_PROD = process.env.NODE_ENV === 'production';
// How long the hangup fallback waits for the Dial callback before billing on its own
const HANGUP_GRACE_MS = parseInt(process.env.HANGUP_GRACE_MS || '15000');
// Grace window for 60-second billing pulses (5s grace: a 61-second call is billed as 1 token instead of 2)
const BILLING_GRACE_SECONDS = parseInt(process.env.BILLING_GRACE_SECONDS || '5');

function calculateTokens(seconds) {
  if (!seconds || seconds <= 0) return 0;
  if (seconds <= 60 + BILLING_GRACE_SECONDS) return 1;
  return Math.ceil((seconds - BILLING_GRACE_SECONDS) / 60);
}

// In production a missing secret is a hard stop, not a warning
const startupProblems = [];
if (JWT_SECRET === DEFAULT_SECRET) startupProblems.push('JWT_SECRET not set — using the built-in default.');
if (!WEBHOOK_TOKEN) startupProblems.push('WEBHOOK_TOKEN not set — anyone who finds the webhook URL can fake calls.');
if (IS_PROD && !PUBLIC_URL) startupProblems.push('PUBLIC_URL not set — callback URLs may point at http instead of your https domain.');
startupProblems.forEach(m => console.warn(`WARNING: ${m}`));
if (IS_PROD && startupProblems.length) {
  console.error('Refusing to start in production. Set the variables above (see .env.example).');
  process.exit(1);
}

// Price list lives on the server so a client cannot submit their own price
// Matches the market offer: 3,000 Tokens for ₹5,000 over 3 months, then ₹1/token
const TOPUP_PLANS = [
  { id: 'starter', name: '500 Tokens', minutes: 500, amount: 500 },
  { id: 'popular', name: '1,000 Tokens', minutes: 1000, amount: 1000, featured: true },
  { id: 'pro', name: '2,000 Tokens', minutes: 2000, amount: 2000 }
];
const PACKAGE = { minutes: 3000, months: 3, amount: 5000, name: '3,000 Tokens Package' };
// When the bundle runs out, calls keep ringing and each extra minute is owed at `rate`, up to `cap`
// unpaid minutes per client, so one client can never run up an unlimited bill.
const OVERAGE = {
  rate: parseFloat(process.env.OVERAGE_RATE || '1'),
  cap: parseInt(process.env.OVERAGE_CAP_MIN || '500')
};
const DEFAULT_NUMBER_RENT = 999;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/recordings', express.static(recordingsDir));

// Frontend Routes
const page = name => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
app.get('/login', page('login.html'));
app.get('/dashboard', page('dashboard.html'));
app.get('/admin', page('admin.html'));
app.get('/', (req, res) => res.redirect('/login'));
// Old VoicePanel links keep working
app.get(/^\/voicepanel\/(login|dashboard|admin)$/i, (req, res) => res.redirect('/' + req.params[0].toLowerCase()));

// Wrap async handlers so a DB error returns JSON instead of hanging the request
const h = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// Middleware for JWT Authentication
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = user;
    next();
  });
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function addMonths(fromDateStr, months) {
  // Extend from the current expiry if it is still in the future, otherwise from today
  const today = new Date();
  const base = fromDateStr && new Date(fromDateStr) > today ? new Date(fromDateStr) : today;
  base.setMonth(base.getMonth() + months);
  return base.toISOString().split('T')[0];
}

function isExpired(dateStr) {
  // A package is valid through the end of its expiry day
  return !!dateStr && new Date(`${dateStr}T23:59:59`) < new Date();
}

// ================= AUTH ENDPOINTS =================
app.post('/api/auth/login', h(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = await get('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Account suspended. Contact administrator.' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, company: user.company_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    default_password: user.role === 'admin' && password === 'admin123',
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      company_name: user.company_name,
      minutes_balance: user.minutes_balance,
      package_expiry_date: user.package_expiry_date
    }
  });
}));

app.post('/api/auth/change-password', authMiddleware, h(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = await get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!user || !bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), req.user.id]);
  res.json({ success: true, message: 'Password changed' });
}));

app.get('/api/plans', authMiddleware, (req, res) => {
  res.json({ plans: TOPUP_PLANS, package: PACKAGE, overage: OVERAGE, upi_id: UPI_ID });
});

// ================= CLIENT DASHBOARD APIS =================
app.get('/api/client/details', authMiddleware, h(async (req, res) => {
  const user = await get(
    'SELECT id, username, company_name, phone, minutes_balance, overage_minutes, overage_enabled, package_expiry_date, status FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });

  const numbers = await all('SELECT * FROM assigned_numbers WHERE user_id = ?', [req.user.id]);
  const usage = await get(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(minutes_deducted), 0) AS minutes,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS answered
     FROM call_logs WHERE user_id = ? AND created_at >= date('now', 'start of month')`,
    [req.user.id]
  );
  res.json({ user, numbers, usage, overage_rate: OVERAGE.rate, overage_cap: OVERAGE.cap });
}));

app.post('/api/client/update-forwarding', authMiddleware, h(async (req, res) => {
  const { number_id, forward_to, label, ring_timeout } = req.body;
  const targets = normalizeList(forward_to);
  if (!number_id || !targets) {
    return res.status(400).json({ error: 'Enter at least one valid forwarding number' });
  }

  const existing = await get('SELECT ring_timeout FROM assigned_numbers WHERE id = ? AND user_id = ?', [number_id, req.user.id]);
  if (!existing) return res.status(404).json({ error: 'Number not found' });

  const timeout = Math.min(Math.max(parseInt(ring_timeout) || existing.ring_timeout || 30, 10), 90);
  await run(
    'UPDATE assigned_numbers SET forward_to = ?, label = ?, ring_timeout = ? WHERE id = ? AND user_id = ?',
    [targets, label?.trim() || 'Main Line', timeout, number_id, req.user.id]
  );
  res.json({ success: true, message: 'Call forwarding updated' });
}));

// Per-day call counts and minutes for the portal charts, bucketed by Indian date
const IST = `'+5 hours', '+30 minutes'`;
async function dailySeries(days, userId) {
  const where = userId ? 'AND user_id = ?' : '';
  const rows = await all(
    `SELECT date(created_at, ${IST}) AS day, COUNT(*) AS calls,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS answered,
            SUM(CASE WHEN status NOT IN ('completed', 'initiated') THEN 1 ELSE 0 END) AS missed,
            COALESCE(SUM(minutes_deducted), 0) AS minutes
     FROM call_logs
     WHERE date(created_at, ${IST}) >= date('now', ${IST}, ?) ${where}
     GROUP BY day`,
    [`-${days - 1} days`, ...(userId ? [userId] : [])]
  );
  const byDay = Object.fromEntries(rows.map(r => [r.day, r]));
  const today = new Date(Date.now() + 330 * 60000);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(today - i * 86400000).toISOString().slice(0, 10);
    const r = byDay[day] || {};
    series.push({ day, calls: r.calls || 0, answered: r.answered || 0, missed: r.missed || 0, minutes: r.minutes || 0 });
  }
  return series;
}
const chartDays = q => Math.min(Math.max(parseInt(q) || 30, 7), 90);

app.get('/api/client/usage', authMiddleware, h(async (req, res) => {
  res.json({ days: await dailySeries(chartDays(req.query.days), req.user.id) });
}));

app.get('/api/client/cdr', authMiddleware, h(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const logs = await all(
    'SELECT * FROM call_logs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [req.user.id, limit]
  );
  res.json({ logs });
}));

// Client Top-Up Request API
app.post('/api/client/topup-request', authMiddleware, h(async (req, res) => {
  const plan = TOPUP_PLANS.find(p => p.id === req.body.plan_id);
  const ref = String(req.body.payment_ref || '').trim();
  if (!plan) return res.status(400).json({ error: 'Choose a valid plan' });
  if (ref.length < 6) return res.status(400).json({ error: 'Enter the UPI reference / UTR from your payment' });

  const pending = await get(`SELECT id FROM topup_requests WHERE user_id = ? AND status = 'pending'`, [req.user.id]);
  if (pending) return res.status(400).json({ error: 'You already have a pending request. Please wait for it to be verified.' });

  await run(
    `INSERT INTO topup_requests (user_id, plan_name, minutes, amount, payment_ref, source)
     VALUES (?, ?, ?, ?, ?, 'client')`,
    [req.user.id, `${plan.name} (${plan.minutes} Mins)`, plan.minutes, plan.amount, ref]
  );
  res.json({ success: true, message: 'Request submitted. Minutes will be credited once the payment is verified.' });
}));

app.get('/api/client/topup-history', authMiddleware, h(async (req, res) => {
  const topups = await all(
    'SELECT * FROM topup_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
    [req.user.id]
  );
  res.json({ topups });
}));

// ================= SUPER-ADMIN APIS =================
app.get('/api/admin/stats', authMiddleware, adminOnly, h(async (req, res) => {
  const month = `date('now', 'start of month')`;
  const revenue = await get(
    `SELECT COALESCE(SUM(amount), 0) AS all_time,
            COALESCE(SUM(CASE WHEN COALESCE(processed_at, created_at) >= ${month} THEN amount ELSE 0 END), 0) AS this_month
     FROM topup_requests WHERE status = 'approved'`
  );
  const calls = await get(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(minutes_deducted), 0) AS minutes
     FROM call_logs WHERE created_at >= ${month}`
  );
  const lines = await get(
    `SELECT COUNT(*) AS active, COALESCE(SUM(COALESCE(p.monthly_cost, 0)), 0) AS rental
     FROM assigned_numbers n LEFT JOIN number_pool p ON p.phone_number = n.phone_number
     WHERE n.status = 'active'`
  );
  const liability = await get(
    `SELECT COALESCE(SUM(minutes_balance), 0) AS minutes FROM users WHERE role = 'client' AND status = 'active'`
  );
  const pending = await get(`SELECT COUNT(*) AS n FROM topup_requests WHERE status = 'pending'`);
  const owed = await get(`SELECT COALESCE(SUM(overage_minutes), 0) AS minutes FROM users WHERE role = 'client'`);

  const callCost = Math.round(calls.minutes * COST_PER_MIN);
  const cost = callCost + lines.rental;
  res.json({
    cost_per_min: COST_PER_MIN,
    revenue_month: revenue.this_month,
    revenue_all_time: revenue.all_time,
    minutes_month: calls.minutes,
    calls_month: calls.calls,
    call_cost_month: callCost,
    rental_month: lines.rental,
    active_lines: lines.active,
    est_cost_month: cost,
    est_margin_month: revenue.this_month - cost,
    unused_minutes: liability.minutes,
    unused_minutes_cost: Math.round(liability.minutes * COST_PER_MIN),
    pending_topups: pending.n,
    overage_minutes: owed.minutes,
    overage_due: Math.round(owed.minutes * OVERAGE.rate)
  });
}));

app.get('/api/admin/usage', authMiddleware, adminOnly, h(async (req, res) => {
  const days = chartDays(req.query.days);
  const series = await dailySeries(days);
  const revenue = await all(
    `SELECT date(COALESCE(processed_at, created_at), ${IST}) AS day, SUM(amount) AS amount
     FROM topup_requests WHERE status = 'approved'
       AND date(COALESCE(processed_at, created_at), ${IST}) >= date('now', ${IST}, ?)
     GROUP BY day`,
    [`-${days - 1} days`]
  );
  const byDay = Object.fromEntries(revenue.map(r => [r.day, r.amount]));
  res.json({
    cost_per_min: COST_PER_MIN,
    days: series.map(d => ({ ...d, revenue: byDay[d.day] || 0, cost: Math.round(d.minutes * COST_PER_MIN) }))
  });
}));

app.get('/api/admin/topup-requests', authMiddleware, adminOnly, h(async (req, res) => {
  const requests = await all(`
    SELECT t.*, u.company_name, u.username, u.minutes_balance as current_balance
    FROM topup_requests t
    JOIN users u ON t.user_id = u.id
    ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.created_at DESC
    LIMIT 200
  `);
  res.json({ requests });
}));

app.post('/api/admin/topup-approve', authMiddleware, adminOnly, h(async (req, res) => {
  const { request_id, action } = req.body; // action: 'approve' or 'reject'
  if (!request_id || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Request ID and action required' });
  }

  const reqRecord = await get('SELECT * FROM topup_requests WHERE id = ?', [request_id]);
  if (!reqRecord) return res.status(404).json({ error: 'Request not found' });

  // Conditional update makes double-clicks / two admins unable to credit twice
  const status = action === 'approve' ? 'approved' : 'rejected';
  const result = await run(
    `UPDATE topup_requests SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
    [status, request_id]
  );
  if (result.changes === 0) return res.status(400).json({ error: 'Request is already processed' });

  if (action === 'reject') return res.json({ success: true, message: 'Top-up request rejected.' });

  await run('UPDATE users SET minutes_balance = minutes_balance + ? WHERE id = ?', [reqRecord.minutes, reqRecord.user_id]);
  res.json({ success: true, message: `Approved — credited ${reqRecord.minutes} minutes.` });
}));

app.get('/api/admin/clients', authMiddleware, adminOnly, h(async (req, res) => {
  const rows = await all(`
    SELECT u.id, u.username, u.company_name, u.phone, u.minutes_balance, u.overage_minutes, u.overage_enabled, u.package_expiry_date, u.status, u.created_at,
           json_group_array(json_object('id', n.id, 'number', n.phone_number, 'label', n.label, 'forward_to', n.forward_to)) as numbers,
           (SELECT COALESCE(SUM(amount), 0) FROM topup_requests t WHERE t.user_id = u.id AND t.status = 'approved') AS revenue,
           (SELECT COALESCE(SUM(minutes_deducted), 0) FROM call_logs c WHERE c.user_id = u.id) AS minutes_used
    FROM users u
    LEFT JOIN assigned_numbers n ON u.id = n.user_id
    WHERE u.role = 'client'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
  const clients = rows.map(r => ({
    ...r,
    numbers: JSON.parse(r.numbers).filter(n => n.id !== null)
  }));
  res.json({ clients });
}));

app.post('/api/admin/clients/create', authMiddleware, adminOnly, h(async (req, res) => {
  const { company_name, username, password, phone } = req.body;
  const minutes = parseInt(req.body.initial_minutes);
  const months = parseInt(req.body.expiry_months);
  const amount = parseInt(req.body.amount_paid);
  if (!company_name?.trim() || !username?.trim() || !password) {
    return res.status(400).json({ error: 'Company, username and password are required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim())) {
    return res.status(400).json({ error: 'Username: 3–32 letters, numbers, _ . -' });
  }

  const expiry = addMonths(null, months > 0 ? months : PACKAGE.months);
  let created;
  try {
    created = await run(
      `INSERT INTO users (username, password_hash, company_name, phone, role, minutes_balance, package_expiry_date)
       VALUES (?, ?, ?, ?, 'client', ?, ?)`,
      [username.trim(), bcrypt.hashSync(password, 10), company_name.trim(), phone?.trim() || '', minutes >= 0 ? minutes : PACKAGE.minutes, expiry]
    );
  } catch (e) {
    return res.status(400).json({ error: 'That username is already taken' });
  }

  // Record the onboarding payment so revenue and margin reports are complete
  if (amount > 0) {
    await run(
      `INSERT INTO topup_requests (user_id, plan_name, minutes, amount, payment_ref, status, source, processed_at)
       VALUES (?, 'Onboarding package', ?, ?, ?, 'approved', 'admin', CURRENT_TIMESTAMP)`,
      [created.lastID, minutes >= 0 ? minutes : PACKAGE.minutes, amount, req.body.payment_ref || 'Collected offline']
    );
  }
  res.json({ success: true, message: `Client created. Valid until ${expiry}.` });
}));

app.post('/api/admin/clients/add-package', authMiddleware, adminOnly, h(async (req, res) => {
  const client = await get(`SELECT * FROM users WHERE id = ? AND role = 'client'`, [req.body.client_id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const expiry = addMonths(client.package_expiry_date, PACKAGE.months);
  await run('UPDATE users SET minutes_balance = minutes_balance + ?, package_expiry_date = ? WHERE id = ?',
    [PACKAGE.minutes, expiry, client.id]);
  await run(
    `INSERT INTO topup_requests (user_id, plan_name, minutes, amount, payment_ref, status, source, processed_at)
     VALUES (?, 'Renewal package', ?, ?, ?, 'approved', 'admin', CURRENT_TIMESTAMP)`,
    [client.id, PACKAGE.minutes, PACKAGE.amount, req.body.payment_ref || 'Collected offline']
  );
  res.json({ success: true, message: `Added ${PACKAGE.minutes} minutes. Valid until ${expiry}.` });
}));

// Client paid their extra minutes: record the payment and clear what they owe
app.post('/api/admin/clients/settle-overage', authMiddleware, adminOnly, h(async (req, res) => {
  const client = await get(`SELECT * FROM users WHERE id = ? AND role = 'client'`, [req.body.client_id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const minutes = client.overage_minutes || 0;
  if (minutes <= 0) return res.status(400).json({ error: 'Nothing is owed' });

  const amount = Math.round(minutes * OVERAGE.rate);
  const cleared = await run('UPDATE users SET overage_minutes = overage_minutes - ? WHERE id = ? AND overage_minutes >= ?',
    [minutes, client.id, minutes]);
  if (!cleared.changes) return res.status(409).json({ error: 'Balance changed, refresh and try again' });
  await run(
    `INSERT INTO topup_requests (user_id, plan_name, minutes, amount, payment_ref, status, source, processed_at)
     VALUES (?, 'Extra minutes', ?, ?, ?, 'approved', 'admin', CURRENT_TIMESTAMP)`,
    [client.id, minutes, amount, req.body.payment_ref || 'Collected offline']
  );
  res.json({ success: true, message: `Recorded ₹${amount} for ${minutes} extra minutes.` });
}));

// Turn ₹1/min extra minutes on or off for one client (off = calls stop at 0 minutes)
app.post('/api/admin/clients/overage', authMiddleware, adminOnly, h(async (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  const r = await run(`UPDATE users SET overage_enabled = ? WHERE id = ? AND role = 'client'`, [enabled, req.body.client_id]);
  if (!r.changes) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true, message: enabled ? 'Extra minutes turned on.' : 'Extra minutes turned off. Calls stop at 0 minutes.' });
}));

app.post('/api/admin/clients/status', authMiddleware, adminOnly, h(async (req, res) => {
  const status = req.body.status === 'suspended' ? 'suspended' : 'active';
  const result = await run(`UPDATE users SET status = ? WHERE id = ? AND role = 'client'`, [status, req.body.client_id]);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true, message: status === 'active' ? 'Client re-activated' : 'Client suspended — their calls will be rejected' });
}));

// Number Inventory / Available Pool API for Suggestions
app.get('/api/admin/number-pool', authMiddleware, adminOnly, h(async (req, res) => {
  const numbers = await all('SELECT * FROM number_pool ORDER BY status ASC, id ASC');
  res.json({ numbers, available_numbers: numbers.filter(n => n.status === 'available') });
}));

app.post('/api/admin/number-pool/add', authMiddleware, adminOnly, h(async (req, res) => {
  const { phone_number, number_type, monthly_cost } = req.body;
  const number = normalizeNumber(phone_number);
  if (number.length < 8) return res.status(400).json({ error: 'Enter a valid number' });

  try {
    await run(
      'INSERT INTO number_pool (phone_number, number_type, monthly_cost) VALUES (?, ?, ?)',
      [number, number_type || '1800 Toll-Free', parseInt(monthly_cost) >= 0 ? parseInt(monthly_cost) : DEFAULT_NUMBER_RENT]
    );
  } catch (e) {
    return res.status(400).json({ error: 'Number already exists in inventory' });
  }
  res.json({ success: true, message: 'Number added to inventory' });
}));

app.post('/api/admin/clients/assign-number', authMiddleware, adminOnly, h(async (req, res) => {
  const { client_id, label } = req.body;
  const number = normalizeNumber(req.body.phone_number);
  const targets = normalizeList(req.body.forward_to);
  if (!client_id || number.length < 8 || !targets) {
    return res.status(400).json({ error: 'Client, 1800/virtual number, and a valid forwarding mobile are required' });
  }

  try {
    await run(
      'INSERT INTO assigned_numbers (user_id, phone_number, label, forward_to) VALUES (?, ?, ?, ?)',
      [client_id, number, label?.trim() || 'Main Line', targets]
    );
  } catch (e) {
    return res.status(400).json({ error: 'This phone number is already assigned' });
  }
  await run(`UPDATE number_pool SET status = 'assigned' WHERE phone_number = ?`, [number]);
  res.json({ success: true, message: 'Number assigned' });
}));

// ================= TELECOM WEBHOOKS (Inbound & Diversion) =================
// Plivo XML by default; Twilio-style TwiML when the request carries a CallSid instead of a CallUUID.
//
// Plivo flow for one inbound call:
//   1. answer_url  -> /incoming      we reply <Record startOnDialAnswer/> + <Dial> to the team's mobiles
//   2. Dial callbackUrl -> /dial-event  'hangup' event per leg carries DialBLegDuration; the answered leg bills
//   3. Dial action -> /call-complete  DialStatus tells us busy / no-answer / failed when nobody picked up
//   4. Record callbackUrl -> /recording  RecordUrl of the conversation
const xmlEscape = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const toE164 = n => (n.length === 10 && /^[6-9]/.test(n) ? `+91${n}` : n);
const webhookParams = req => ({ ...req.query, ...req.body });
const isPlivo = p => (p.CallUUID || p.DialALegUUID ? true : p.CallSid ? false : PROVIDER !== 'twilio');
const isExotel = (p, req) => {
  if (PROVIDER === 'exotel' || p?.provider === 'exotel') return true;
  if (p?.CallFrom || p?.CallTo || p?.DialCallDuration !== undefined || p?.DialCallStatus !== undefined || p?.CallType !== undefined) return true;
  const ua = req?.get ? req.get('user-agent') || '' : '';
  return /exotel/i.test(ua);
};
// Plivo reports no-answer as 'timeout'/'no-answer' and caller hang-up while ringing as 'cancel'
const DIAL_STATUS = { 'no-answer': 'no-answer', timeout: 'no-answer', cancel: 'missed', canceled: 'missed', busy: 'busy', failed: 'failed', completed: 'completed' };

function webhookAuth(req, res, next) {
  if (WEBHOOK_TOKEN && (req.query.token || req.body?.token) !== WEBHOOK_TOKEN) {
    return res.status(403).send('Forbidden');
  }
  next();
}

function hookUrl(req, name) {
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const tokenQs = WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : '';
  return xmlEscape(`${base}/api/webhook/${name}${tokenQs}`);
}

function sendXml(res, body) {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`);
}

function rejectCall(res, plivo) {
  const msg = 'The number you have dialed is currently unavailable. Please try again later.';
  sendXml(res, plivo ? `  <Speak language="en-IN">${msg}</Speak>\n  <Hangup/>` : `  <Say language="en-IN">${msg}</Say>\n  <Hangup/>`);
}

// Bill a finished call exactly once — carriers retry webhooks, and parallel legs each report a hangup
async function finishCall(callId, { seconds = 0, status, recording }) {
  const log = await get('SELECT user_id FROM call_logs WHERE call_sid = ?', [callId]);
  if (!log) return;
  const minutes = calculateTokens(seconds);
  const result = await run(
    `UPDATE call_logs SET duration_seconds = ?, minutes_deducted = ?, status = ?,
            recording_file = COALESCE(NULLIF(?, ''), recording_file)
     WHERE call_sid = ? AND status = 'initiated'`,
    [seconds, minutes, status, recording || '', callId]
  );
  if (result.changes > 0 && minutes > 0) {
    // Minutes past the bundle become overage owed at OVERAGE.rate (SET reads the pre-update row)
    await run(
      `UPDATE users SET overage_minutes = overage_minutes + MAX(0, ? - minutes_balance),
                        minutes_balance = MAX(0, minutes_balance - ?) WHERE id = ?`,
      [minutes, minutes, log.user_id]
    );
  }
}

const safeUrl = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

app.all('/api/webhook/incoming', webhookAuth, h(async (req, res) => {
  const params = webhookParams(req);
  const plivo = isPlivo(params);
  const dialedRaw = String(params.To || params.CallTo || params.dialed_number || params.Called || '');
  const dialedNumber = normalizeNumber(dialedRaw);
  const callerNumber = String(params.From || params.CallFrom || params.caller_number || params.Caller || 'Unknown').slice(0, 32);
  const callSid = String(params.CallUUID || params.CallSid || params.call_sid || `CALL_${Date.now()}`).slice(0, 64);

  // Find who owns this number
  const assignment = await get(
    `SELECT n.*, u.id as user_id, u.minutes_balance, u.overage_minutes, u.overage_enabled, u.package_expiry_date, u.status as user_status
     FROM assigned_numbers n
     JOIN users u ON n.user_id = u.id
     WHERE n.phone_number = ? AND n.status = 'active'`,
    [dialedNumber]
  );

  // Minutes this call may use: what's left in the bundle plus unused overage headroom
  const allowance = assignment
    ? assignment.minutes_balance + (assignment.overage_enabled ? Math.max(0, OVERAGE.cap - assignment.overage_minutes) : 0)
    : 0;
  // Number not configured, client suspended, out of minutes or package expired
  if (!assignment || assignment.user_status !== 'active' || allowance <= 0 || isExpired(assignment.package_expiry_date)) {
    if (isExotel(params, req)) {
      return res.status(302).send('Number unavailable or balance exhausted');
    }
    return rejectCall(res, plivo);
  }

  // Log initial call leg with Campaign / Department Line Tag
  const dialedDisplay = assignment.label ? `${dialedNumber} [${assignment.label}]` : dialedNumber;
  await run(
    `INSERT OR IGNORE INTO call_logs (user_id, call_sid, caller_number, dialed_number, forwarded_to, status)
     VALUES (?, ?, ?, ?, ?, 'initiated')`,
    [assignment.user_id, callSid, callerNumber, dialedDisplay, assignment.forward_to]
  );

  // Simultaneous ringing on every forwarding number (parallel hunt group)
  const targetNumbers = assignment.forward_to.split(/[\s,;]+/).filter(Boolean).map(toE164);
  const numberTags = targetNumbers.map(num => `    <Number>${xmlEscape(num)}</Number>`).join('\n');

  // Cap the call at the allowance so a client can never talk past the bundle plus the overage cap
  const timeLimit = allowance * 60;
  const ring = assignment.ring_timeout || 30;
  // Indian carriers only accept a caller ID you own, so the forwarded leg shows the dialed number
  const callerId = xmlEscape(dialedRaw || dialedNumber);

  if (isExotel(params, req)) {
    // Exotel Connect Applet (Application URL): expects 200 OK with comma-separated numbers in text/plain
    // Exotel Passthru Applet: evaluates 200 OK as success branch
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(targetNumbers.join(','));
  }

  if (plivo) {
    const record = assignment.record_calls
      ? `  <Record startOnDialAnswer="true" redirect="false" fileFormat="mp3" maxLength="${timeLimit}" callbackUrl="${hookUrl(req, 'recording')}"/>\n`
      : '';
    return sendXml(res, `${record}  <Dial timeout="${ring}" timeLimit="${timeLimit}" callerId="${callerId}" action="${hookUrl(req, 'call-complete')}" callbackUrl="${hookUrl(req, 'dial-event')}">
${numberTags}
  </Dial>`);
  }

  sendXml(res, `  <Dial timeout="${ring}" timeLimit="${timeLimit}" record="${assignment.record_calls ? 'record-from-answer' : 'do-not-record'}" action="${hookUrl(req, 'call-complete')}" callerId="${callerId}">
${numberTags}
  </Dial>`);
}));

// Plivo Dial callbackUrl: one 'hangup' per forwarded leg. Only the leg that talked has a duration.
app.all('/api/webhook/dial-event', webhookAuth, h(async (req, res) => {
  const p = webhookParams(req);
  const callId = p.DialALegUUID || p.CallUUID;
  const seconds = Math.max(parseInt(p.DialBLegDuration || p.DialBLegBillDuration || 0) || 0, 0);
  // Plivo sends DialAction=hangup; Vobiz sends Event=DialHangup
  if (callId && (p.DialAction === 'hangup' || p.Event === 'DialHangup') && seconds > 0) {
    await finishCall(callId, { seconds, status: 'completed' });
  }
  res.send('OK');
}));

// Dial action: Twilio sends the talk time here; Plivo only sends the outcome
app.all('/api/webhook/call-complete', webhookAuth, h(async (req, res) => {
  const p = webhookParams(req);
  const callId = p.CallUUID || p.DialALegUUID || p.CallSid || p.call_sid;

  if (callId && isPlivo(p)) {
    const status = DIAL_STATUS[String(p.DialStatus || '').toLowerCase()] || 'failed';
    // An answered call is billed by /dial-event; if that event never arrives the row stays 'initiated'
    if (status !== 'completed') await finishCall(callId, { status });
  } else if (callId) {
    const seconds = Math.max(parseInt(p.DialCallDuration || p.Duration || p.duration || 0) || 0, 0);
    const status = String(p.DialCallStatus || p.CallStatus || 'completed').slice(0, 20);
    await finishCall(callId, { seconds, status, recording: safeUrl(p.RecordingUrl || p.recording_url) });
  }

  if (isExotel(p, req)) {
    return res.status(200).send('OK');
  }

  sendXml(res, '  <Hangup/>');
}));

// Plivo Record callbackUrl: may arrive before or after billing, so it only fills the recording
app.all('/api/webhook/recording', webhookAuth, h(async (req, res) => {
  const p = webhookParams(req);
  const callId = p.CallUUID || p.DialALegUUID;
  const url = safeUrl(p.RecordUrl);
  if (callId && url) {
    await run(`UPDATE call_logs SET recording_file = ? WHERE call_sid = ? AND COALESCE(recording_file, '') = ''`, [url, callId]);
  }
  res.send('OK');
}));

// Plivo Application hangup_url: fires when the caller's leg ends. Safety net for a lost /dial-event —
// wait for the Dial callbacks first, then bill from the A-leg only if the call is still unbilled.
// The A-leg duration includes ring time, so it can overstate talk time by up to the ring timeout.
app.all('/api/webhook/hangup', webhookAuth, h(async (req, res) => {
  const p = webhookParams(req);
  const callId = p.CallUUID;
  const seconds = Math.max(parseInt(p.Duration || p.BillDuration || 0) || 0, 0);
  res.send('OK');
  if (!callId) return;
  setTimeout(() => {
    finishCall(callId, { seconds, status: seconds > 0 ? 'completed' : 'missed' })
      .catch(e => console.error('hangup fallback failed:', e.message));
  }, HANGUP_GRACE_MS).unref();
}));

function start() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bolo1800 system running on port ${PORT}`);
    console.log(`Access directly at: ${PUBLIC_URL || 'http://<YOUR_SERVER_IP>'}/login`);
  });
}

if (require.main === module) {
  setTimeout(() => get(`SELECT password_hash FROM users WHERE role = 'admin' AND username = 'admin'`).then(row => {
    if (row && bcrypt.compareSync('admin123', row.password_hash)) {
      console.warn('⚠️  SECURITY WARNING: Default super-admin password is "admin123". Please change it in the Admin Console.');
    }
    start();
  }).catch(() => start()), 500);
}

module.exports = app;
