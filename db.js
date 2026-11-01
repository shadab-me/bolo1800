const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const recordingsDir = path.join(dataDir, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// Installs from before the Bolo1800 rename keep their existing database file
const legacyDbPath = path.join(dataDir, 'voicepanel.db');
const dbPath = fs.existsSync(legacyDbPath) ? legacyDbPath : path.join(dataDir, 'bolo1800.db');
const db = new sqlite3.Database(dbPath);

// Canonical form for every number we store or look up, so "+91 1800-200-9999",
// "911800200 9999" and "18002009999" all match the same row.
function normalizeNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  return d;
}

function normalizeList(raw) {
  return String(raw || '')
    // Spaces are part of how people type numbers ("+91 98765 43210"), so never split on them
    .split(/[,;/\n]+/)
    .map(normalizeNumber)
    .filter(n => n.length >= 8)
    .join(', ');
}

// Promise wrappers so route handlers can use async/await
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  // Users (Super Admin and B2B Clients)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT NOT NULL,
      role TEXT DEFAULT 'client', -- 'admin' or 'client'
      phone TEXT,
      minutes_balance INTEGER DEFAULT 0,
      package_expiry_date TEXT,
      status TEXT DEFAULT 'active', -- 'active' or 'suspended'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Assigned Numbers (e.g. 1800-XXX-XXXX or Virtual Mobile numbers)
  db.run(`
    CREATE TABLE IF NOT EXISTS assigned_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      phone_number TEXT UNIQUE NOT NULL, -- The 1800 or virtual number
      label TEXT DEFAULT 'Main Line',    -- e.g. 'Sales', 'Support', 'Google Ads'
      forward_to TEXT NOT NULL,          -- Divert destination mobile(s)
      ring_timeout INTEGER DEFAULT 30,   -- In seconds
      record_calls INTEGER DEFAULT 1,    -- 1 = Yes, 0 = No
      status TEXT DEFAULT 'active',
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Unassigned Numbers Pool (Available Inventory)
  db.run(`
    CREATE TABLE IF NOT EXISTS number_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      number_type TEXT DEFAULT '1800 Toll-Free',
      monthly_cost INTEGER DEFAULT 999,  -- What YOU pay the carrier per month (₹)
      status TEXT DEFAULT 'available', -- 'available' or 'assigned'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Call Detail Records (CDR)
  db.run(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      call_sid TEXT UNIQUE,
      caller_number TEXT NOT NULL,
      dialed_number TEXT NOT NULL,
      forwarded_to TEXT NOT NULL,
      duration_seconds INTEGER DEFAULT 0,
      minutes_deducted INTEGER DEFAULT 0,
      status TEXT DEFAULT 'initiated', -- 'completed', 'missed', 'busy', 'failed'
      recording_file TEXT,             -- Local relative file path
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Top-Up Requests / Payments ledger (client requests + admin-credited packages)
  db.run(`
    CREATE TABLE IF NOT EXISTS topup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      plan_name TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      payment_ref TEXT,
      status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migrations for databases created by older versions (errors = column already exists)
  db.run(`ALTER TABLE topup_requests ADD COLUMN source TEXT DEFAULT 'client'`, () => {});
  db.run(`ALTER TABLE topup_requests ADD COLUMN processed_at DATETIME`, () => {});
  // Extra minutes used past the bundle, owed at the overage rate; and whether a client may use them
  db.run(`ALTER TABLE users ADD COLUMN overage_minutes INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN overage_enabled INTEGER DEFAULT 1`, () => {});

  // Bring numbers stored before normalization existed into canonical form
  db.all('SELECT id, phone_number, forward_to FROM assigned_numbers', (err, rows) => {
    (rows || []).forEach(r => {
      const p = normalizeNumber(r.phone_number);
      const f = normalizeList(r.forward_to) || r.forward_to;
      if (p !== r.phone_number || f !== r.forward_to) {
        db.run('UPDATE assigned_numbers SET phone_number = ?, forward_to = ? WHERE id = ?', [p, f, r.id], () => {});
      }
    });
  });
  db.all('SELECT id, phone_number FROM number_pool', (err, rows) => {
    (rows || []).forEach(r => {
      const p = normalizeNumber(r.phone_number);
      if (p !== r.phone_number) db.run('UPDATE number_pool SET phone_number = ? WHERE id = ?', [p, r.id], () => {});
    });
  });

  // Seed default super-admin if not exists
  db.get(`SELECT id FROM users WHERE role = 'admin'`, (err, row) => {
    if (!row) {
      const initialPass = process.env.ADMIN_PASSWORD || 'admin123';
      const defaultPassHash = bcrypt.hashSync(initialPass, 10);
      db.run(
        `INSERT INTO users (username, password_hash, company_name, role, minutes_balance) VALUES (?, ?, ?, 'admin', 999999)`,
        ['admin', defaultPassHash, 'Bolo1800 Super Admin']
      );
      console.log(process.env.ADMIN_PASSWORD
        ? 'Super-admin created: username="admin", password from ADMIN_PASSWORD.'
        : 'Default super-admin created: username="admin", password="admin123" — change it after first login!');
    }
  });
});

module.exports = { db, recordingsDir, run, get, all, normalizeNumber, normalizeList };
