// Shared helpers for all Bolo1800 pages: API calls, escaping, toasts, icons, formatting
(function () {
  const TOKEN_KEY = 'vp_token';
  const USER_KEY = 'vp_user';

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function session() {
    try {
      return { token: localStorage.getItem(TOKEN_KEY), user: JSON.parse(localStorage.getItem(USER_KEY) || 'null') };
    } catch (e) {
      return { token: null, user: null };
    }
  }

  function saveSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = '/login';
  }

  // Only an auth failure logs the user out; network or server errors surface as a toast
  async function api(path, body) {
    const opts = { headers: { Authorization: `Bearer ${session().token}` } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new Error('Network error — check your connection');
    }
    if (res.status === 401) {
      logout();
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function toast(message, type = 'success') {
    let wrap = document.getElementById('toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toast-wrap';
      wrap.setAttribute('aria-live', 'polite');
      wrap.className = 'fixed top-20 right-4 left-4 sm:left-auto z-[100] flex flex-col gap-2 items-stretch sm:items-end pointer-events-none';
      document.body.appendChild(wrap);
    }
    const tone = type === 'error'
      ? 'bg-red-50 border-red-200 text-red-800'
      : 'bg-emerald-50 border-emerald-200 text-emerald-800';
    const el = document.createElement('div');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.className = `pointer-events-auto flex items-start gap-2 border rounded-lg px-4 py-3 text-sm font-medium shadow-sm sm:max-w-sm vp-toast ${tone}`;
    el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check', 'w-4 h-4 mt-0.5 shrink-0')}<span>${esc(message)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, type === 'error' ? 6000 : 3500);
  }

  // Lucide icon paths (MIT), rendered inline so there is no extra network request
  const PATHS = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    incoming: '<polyline points="16 2 16 8 22 8"/><line x1="22" y1="2" x2="16" y2="8"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    trending: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
    grid: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'
  };

  function icon(name, cls = 'w-5 h-5') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
  }

  const inr = n => (Number(n) < 0 ? '−₹' : '₹') + Math.abs(Number(n || 0)).toLocaleString('en-IN');
  const num = n => Number(n || 0).toLocaleString('en-IN');

  // SQLite CURRENT_TIMESTAMP is UTC without a zone marker
  function dateTime(s) {
    if (!s) return '—';
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function daysLeft(dateStr) {
    if (!dateStr) return null;
    const end = new Date(`${dateStr}T23:59:59`);
    return Math.ceil((end - new Date()) / 86400000);
  }

  function prettyNumber(n) {
    const d = String(n || '').replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1800')) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
    if (d.length === 10) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
    return n || '';
  }

  function duration(sec) {
    sec = Number(sec || 0);
    if (!sec) return '0s';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  }

  // Modal open/close with Escape and backdrop click; focus moves into the dialog
  function openModal(id) {
    const m = document.getElementById(id);
    m.classList.remove('hidden');
    m.classList.add('flex');
    setTimeout(() => m.querySelector('input:not([type=hidden]),select,textarea,button')?.focus(), 30);
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    m.classList.add('hidden');
    m.classList.remove('flex');
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('[data-modal].flex').forEach(m => closeModal(m.id));
  });
  document.addEventListener('click', e => {
    if (e.target.matches('[data-modal]')) closeModal(e.target.id);
    const closer = e.target.closest('[data-close]');
    if (closer) closeModal(closer.dataset.close);
  });

  // Disable a submit button while its request is in flight
  async function busy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="vp-spin"></span>';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }

  const shortDay = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  // Hand-drawn SVG chart: stacked bars and/or lines over a day axis, with a hover/focus tooltip.
  // series: [{ key, label, color, type: 'bar'|'line', dash, hatch }]; tip(row) returns tooltip HTML.
  function chart(el, { data, series, fmt = num, tip, height = 240 }) {
    const draw = () => {
      const W = Math.max(el.clientWidth, 280), H = height;
      const pad = { t: 12, r: 12, b: 26, l: 44 };
      const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
      const bars = series.filter(s => s.type === 'bar'), lines = series.filter(s => s.type === 'line');
      const max = Math.max(1, ...data.map(r => bars.reduce((a, s) => a + (r[s.key] || 0), 0)), ...data.flatMap(r => lines.map(s => r[s.key] || 0)));
      // Round the axis to a tidy step so gridlines land on whole numbers
      const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = Math.max(1, [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw));
      const top = step * Math.ceil(max / step);
      const y = v => pad.t + ih - (v / top) * ih;
      const bw = iw / data.length, barW = Math.max(2, Math.min(28, bw * 0.62));
      const cx = i => pad.l + bw * i + bw / 2;
      const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 56)));

      let svg = `<defs>${series.filter(s => s.hatch).map(s => `<pattern id="vp-h-${s.key}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${s.color}" opacity=".35"/><line x1="0" y1="0" x2="0" y2="6" stroke="${s.color}" stroke-width="3"/></pattern>`).join('')}</defs>`;
      for (let v = 0; v <= top; v += step) {
        svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#E2E8F0" ${v ? 'stroke-dasharray="3 4"' : ''}/>`;
        svg += `<text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
      }
      data.forEach((r, i) => {
        let acc = 0;
        bars.forEach(s => {
          const v = r[s.key] || 0;
          if (!v) return;
          const y0 = y(acc), y1 = y(acc + v);
          svg += `<rect x="${cx(i) - barW / 2}" y="${y1}" width="${barW}" height="${Math.max(1, y0 - y1)}" rx="${Math.min(4, barW / 3)}" fill="${s.hatch ? `url(#vp-h-${s.key})` : s.color}"/>`;
          acc += v;
        });
        // Count label spacing back from today so the newest day is always labelled; clamp it so it is not clipped at the edge
        if ((data.length - 1 - i) % every === 0) svg += `<text x="${Math.min(cx(i), W - 22)}" y="${H - 8}" text-anchor="middle">${esc(shortDay(r.day))}</text>`;
      });
      lines.forEach(s => {
        const pts = data.map((r, i) => `${cx(i).toFixed(1)},${y(r[s.key] || 0).toFixed(1)}`).join(' ');
        svg += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="6 5"' : ''}/>`;
      });
      // Invisible per-day hit areas, each followed by its highlight band (CSS sibling hover)
      data.forEach((r, i) => {
        svg += `<rect class="vp-hit" data-i="${i}" x="${pad.l + bw * i}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent" tabindex="0" aria-label="${esc(shortDay(r.day))}"/>`;
        svg += `<rect class="vp-hl" x="${pad.l + bw * i}" y="${pad.t}" width="${bw}" height="${ih}" fill="#2563EB" opacity="0" style="fill-opacity:.06"/>`;
      });
      el.innerHTML = `<svg class="vp-chart block" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily chart">${svg}</svg><div class="vp-tip hidden absolute z-10 pointer-events-none rounded-lg bg-slate-900 text-white text-xs px-3 py-2 shadow-lg"></div>`;
      el.style.position = 'relative';
      const tipEl = el.querySelector('.vp-tip');
      const show = e => {
        const i = Number(e.target.dataset.i);
        if (Number.isNaN(i)) return;
        tipEl.innerHTML = `<p class="font-semibold mb-1">${esc(shortDay(data[i].day))}</p>${tip(data[i])}`;
        tipEl.classList.remove('hidden');
        const left = Math.min(Math.max(cx(i) - tipEl.offsetWidth / 2, 0), W - tipEl.offsetWidth);
        tipEl.style.left = left + 'px';
        tipEl.style.top = '0px';
      };
      const hide = () => tipEl.classList.add('hidden');
      el.querySelectorAll('.vp-hit').forEach(h => {
        h.addEventListener('mouseenter', show); h.addEventListener('focus', show);
        h.addEventListener('mouseleave', hide); h.addEventListener('blur', hide);
      });
    };
    draw();
    if (!el._vpObserver && window.ResizeObserver) {
      let last = el.clientWidth;
      el._vpObserver = new ResizeObserver(() => { if (el.clientWidth !== last) { last = el.clientWidth; el._vpDraw(); } });
      el._vpObserver.observe(el);
    }
    el._vpDraw = draw;
  }

  // Initials for avatar circles, e.g. "Sharma Traders" -> "ST"
  const initials = s => String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

  window.VP = { esc, session, saveSession, logout, api, toast, icon, inr, num, dateTime, daysLeft, prettyNumber, duration, openModal, closeModal, busy, chart, shortDay, initials };

  // Mobile sidebar drawer: [data-drawer] toggles it, the scrim, Escape or any nav link inside closes it
  document.addEventListener('click', e => {
    if (e.target.closest('[data-drawer]')) document.body.classList.toggle('vp-drawer-open');
    else if (e.target.closest('.vp-scrim, .vp-sidebar .vp-nav-item')) document.body.classList.remove('vp-drawer-open');
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.body.classList.remove('vp-drawer-open'); });

  // Render any <i data-icon="name"> placeholders in static markup
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('i[data-icon]').forEach(i => { i.outerHTML = icon(i.dataset.icon, i.className || 'w-5 h-5'); });
  });
})();
