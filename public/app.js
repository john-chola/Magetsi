/* Magetsi app: talks to the Node server, or runs a self-contained demo when no server answers. */
(function () {
  'use strict';
  const C = window.MagetsiCore;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- storage (wrapped: storage can be missing or throw) ----------
  const mem = {};
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('mg.' + k); return v == null ? (k in mem ? mem[k] : d) : JSON.parse(v); } catch { return k in mem ? mem[k] : d; } },
    set(k, v) { mem[k] = v; try { localStorage.setItem('mg.' + k, JSON.stringify(v)); } catch { /* in-memory only */ } },
  };
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  const deviceId = LS.get('device') || (() => { const id = newId(); LS.set('device', id); return id; })();

  const settings = C.cleanSettings(LS.get('settings', {}));
  const saveSettings = () => { LS.set('settings', settings); schedulePushSync(); };

  // ---------- backends ----------
  const ServerBackend = {
    mode: 'server',
    async req(path, opts) {
      const r = await fetch(path, opts);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      return j;
    },
    post(path, body) { return this.req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    areas() { return this.req('api/areas'); },
    schedule(area) { return this.req(`api/schedule?area=${area}&days=7`); },
    status(area) { return this.req(`api/status?area=${area}&device=${encodeURIComponent(deviceId)}`); },
    stats(area) { return this.req(`api/stats?area=${area}&days=7`); },
    off(area) { return this.post('api/outages/off', { area, device: deviceId }); },
    on(area) { return this.post('api/outages/on', { area, device: deviceId }); },
    manual(area, off_at, on_at) { return this.post('api/outages', { area, device: deviceId, off_at, on_at }); },
  };

  // Demo: same API, computed in the browser from a generated rotation + synthetic reports.
  const DemoBackend = {
    mode: 'demo',
    init() {
      const now = Date.now();
      this.slots = C.rotationSlots(C.addDays(C.lusakaDate(now), -8), 22);
      this.outages = C.demoOutages(C.AREAS, this.slots, now, 7);
      for (const o of LS.get('demo.mine', [])) this.outages.push(o);
    },
    area(id) { const a = C.AREAS.find((x) => x.id === Number(id)); if (!a) throw new Error('Unknown area'); return a; },
    slotsFor(a) { return this.slots.filter((s) => s.group_code === a.group_code); },
    forArea(a) { return this.outages.filter((o) => o.area_id === a.id); },
    persist() { LS.set('demo.mine', this.outages.filter((o) => o.device_id === deviceId)); },
    async areas() { return { areas: C.AREAS.map((a) => ({ ...a, group_name: C.groupName(a.group_code) })), groups: C.GROUPS }; },
    async schedule(id) {
      const a = this.area(id), today = C.lusakaDate(Date.now()), end = C.addDays(today, 7), from = C.addDays(today, -1);
      return { area: a, slots: this.slotsFor(a).filter((s) => s.date >= from && s.date <= end) };
    },
    async status(id) {
      const a = this.area(id);
      return { area: a, status: C.computeStatus({ slots: this.slotsFor(a), outages: this.forArea(a), now: Date.now(), deviceId }) };
    },
    async stats(id) {
      const a = this.area(id), now = Date.now();
      return { area: a, stats: C.adherence({ slots: this.slotsFor(a), outages: this.forArea(a), fromMs: now - 7 * C.DAY, toMs: now }) };
    },
    async off(id) {
      const a = this.area(id);
      const open = this.outages.find((o) => o.device_id === deviceId && o.onMs == null);
      if (open) return { outage: open, duplicate: true };
      const o = { area_id: a.id, device_id: deviceId, offMs: Date.now(), onMs: null, manual: 0, flagged: 0 };
      this.outages.push(o); this.persist();
      return { outage: o };
    },
    async on() {
      const open = this.outages.find((o) => o.device_id === deviceId && o.onMs == null);
      if (!open) throw new Error('No open outage for this device');
      open.onMs = Date.now(); this.persist();
      return { outage: open };
    },
    async manual(id, off_at, on_at) {
      const a = this.area(id);
      const err = C.validateManualOutage(off_at, on_at, Date.now());
      if (err) throw new Error(err);
      const o = { area_id: a.id, device_id: deviceId, offMs: off_at, onMs: on_at, manual: 1, flagged: 0 };
      this.outages.push(o); this.persist();
      return { outage: o };
    },
  };

  let api = ServerBackend;
  async function pickBackend() {
    if (location.protocol === 'file:') return useDemo();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch('api/health', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      const j = await r.json();
      if (!j.ok) throw new Error('no');
    } catch { useDemo(); }
  }
  function useDemo() { api = DemoBackend; DemoBackend.init(); $('#demoPill').hidden = false; }

  // ---------- state ----------
  const MAX_SAVED = 5;
  const S = {
    areas: [],
    areaId: LS.get('area', null),       // the area on screen
    saved: null,                         // areas the user follows (alerts cover all of them)
    slotsBy: LS.get('cache.slotsBy', {}),
    status: null, stats: null, tab: 'home', busy: false,
    push: false, pushErr: null, smsInfo: null, smsPending: null,
  };
  S.saved = LS.get('saved', S.areaId ? [S.areaId] : []);
  if (S.areaId && !S.slotsBy[S.areaId] && LS.get('cache.slots', null)) S.slotsBy[S.areaId] = LS.get('cache.slots', []); // cache from v1
  const areaById = (id) => S.areas.find((a) => a.id === id) || null;
  const currentArea = () => areaById(S.areaId);
  const curSlots = () => S.slotsBy[S.areaId] || [];

  // ---------- formatting ----------
  const t = (ms) => C.lusakaTime(ms);
  function dayLabel(ms) {
    const d = C.lusakaDate(ms), today = C.lusakaDate(Date.now());
    if (d === today) return 'today';
    if (d === C.addDays(today, 1)) return 'tomorrow';
    return `${C.weekday(d)} ${Number(d.slice(8))}`;
  }
  function dur(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
  }
  const hours = (ms) => { const h = ms / C.HOUR; return h >= 1 ? `${Math.round(h * 10) / 10} h` : `${Math.round(ms / C.MIN)} min`; };
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const niceDate = (d) => `${C.weekday(d)} ${Number(d.slice(8))} ${months[Number(d.slice(5, 7)) - 1]}`;

  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  // ---------- saved areas ----------
  function selectArea(id) {
    if (!S.saved.includes(id)) {
      if (S.saved.length >= MAX_SAVED) { toast(`You can follow up to ${MAX_SAVED} areas. Remove one first.`); return false; }
      S.saved.push(id); LS.set('saved', S.saved);
      schedulePushSync();
    }
    if (S.areaId !== id) { S.areaId = id; LS.set('area', id); S.status = null; S.stats = null; }
    render(); loadAll();
    return true;
  }
  function removeSaved(id) {
    S.saved = S.saved.filter((x) => x !== id); LS.set('saved', S.saved);
    delete S.slotsBy[id]; LS.set('cache.slotsBy', S.slotsBy);
    if (S.areaId === id) {
      S.areaId = S.saved.length ? S.saved[0] : null; LS.set('area', S.areaId); S.status = null; S.stats = null;
      if (S.areaId) loadAll();
    }
    render(); schedulePushSync();
  }

  // ---------- rendering: home ----------
  function areaSwitcher() {
    const chips = S.saved.map(areaById).filter(Boolean).map((a) =>
      `<button data-go="${a.id}" class="${a.id === S.areaId ? 'on' : ''}" aria-pressed="${a.id === S.areaId}">${esc(a.name)}</button>`).join('');
    const add = S.saved.length < MAX_SAVED ? `<button data-add aria-label="Follow another area">+ Area</button>` : '';
    return `<div class="areas-row" role="group" aria-label="Your areas">${chips}${add}</div>`;
  }
  function renderHome() {
    const el = $('#home');
    const area = currentArea();
    if (!area) {
      el.innerHTML = `<div class="welcome">
        <svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="#ffb627"/></svg>
        <h1>Know before the lights go</h1>
        <p>Pick your area to see its load-shedding schedule, get a reminder before power goes off, and log real outages for your neighbours. Add home, work and family areas.</p>
        <button class="btn primary" style="width:100%" id="pickFirst">Choose my area</button></div>`;
      $('#pickFirst').onclick = openAreaDlg;
      return;
    }
    const st = S.status;
    if (!st) { el.innerHTML = areaSwitcher() + '<div class="empty">Loading…</div>'; bindSwitcher(el); return; }
    const now = Date.now();
    const off = st.likely === 'off';
    const c = st.community;

    let sub = '', countdown = '';
    if (st.nextChangeMs) {
      countdown = `<div class="countdown" id="countdown">${dur(st.nextChangeMs - now)}</div>`;
      sub = st.nextChange === 'on'
        ? `Scheduled back on at <span class="tm">${t(st.nextChangeMs)}</span> ${dayLabel(st.nextChangeMs)}`
        : `Next scheduled outage at <span class="tm">${t(st.nextChangeMs)}</span> ${dayLabel(st.nextChangeMs)}`;
    } else sub = 'No upcoming outages in the published schedule.';

    let note;
    if (c.unscheduled) note = `<span class="warn"><b>${c.offNow} households</b> report power off now. This outage is <b>not on the schedule</b>.</span>`;
    else if (st.scheduledOff && st.likely === 'on') note = `<b>${c.recentlyBack} households</b> say power is back early.`;
    else if (c.offNow > 0) note = `<b>${c.offNow}</b> household${c.offNow > 1 ? 's' : ''} in ${esc(area.name)} report${c.offNow > 1 ? '' : 's'} power off now.`;
    else note = `No live reports from ${esc(area.name)} right now.`;

    const mine = st.myOpenOutage;
    const reportBtn = mine
      ? `<button class="btn primary" id="btnOn"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor"/></svg>Power is back</button>
         <p class="hint">You reported power off at ${t(mine.offMs)} · ${hours(now - mine.offMs)} ago</p>`
      : `<button class="btn danger" id="btnOff"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8zM3 3l18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Power went off</button>`;

    // upcoming windows from cached schedule
    const ups = C.mergedWindows(curSlots()).filter((w) => w.endMs > now).slice(0, 3);
    const upHtml = ups.length ? ups.map((w) => `<div class="next-row"><div><span class="tm">${t(w.startMs)}–${t(w.endMs)}</span></div><div class="when">${w.startMs <= now ? 'now' : dayLabel(w.startMs)} · ${hours(w.endMs - w.startMs)}</div></div>`).join('')
      : '<div class="next-row">No upcoming outages.</div>';

    el.innerHTML = `
      ${areaSwitcher()}
      <div class="status ${off ? 'off' : 'on'}" aria-live="polite">
        <div class="label"><span class="dot"></span>${esc(area.name)}${area.town && area.town !== 'Lusaka' ? ', ' + esc(area.town) : ''} · ${esc(C.groupName(area.group_code))}${st.scheduledOff !== off ? ' · from live reports' : ''}</div>
        <div class="big">${off ? 'Power OFF' : 'Power ON'}</div>
        <div class="sub">${sub}</div>
        ${countdown}
        <div class="note">${note}</div>
      </div>
      <div class="report">${reportBtn}
        <button class="btn ghost" id="btnLog">Log a past outage</button>
      </div>
      <h2>Next outages</h2>
      <div class="next">${upHtml}</div>`;
    const b1 = $('#btnOff'), b2 = $('#btnOn');
    if (b1) b1.onclick = () => report('off');
    if (b2) b2.onclick = () => report('on');
    $('#btnLog').onclick = openLogDlg;
    bindSwitcher(el);
  }
  function bindSwitcher(el) {
    el.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => selectArea(Number(b.dataset.go)));
    const add = el.querySelector('[data-add]'); if (add) add.onclick = openAreaDlg;
  }

  function tickCountdown() {
    const el = $('#countdown');
    if (!el || !S.status || !S.status.nextChangeMs) return;
    const left = S.status.nextChangeMs - Date.now();
    if (left <= 0) { refreshStatus(); return; }
    el.textContent = dur(left);
  }

  // ---------- rendering: schedule ----------
  function renderSchedule() {
    const el = $('#schedule');
    const area = currentArea();
    if (!area) { el.innerHTML = '<div class="empty">Choose your area first.</div>'; return; }
    const now = Date.now(), today = C.lusakaDate(now);
    const ws = C.mergedWindows(curSlots());
    let html = `${S.saved.length > 1 ? areaSwitcher() : ''}<h2>${esc(area.name)} · ${esc(C.groupName(area.group_code))} · next 7 days</h2>
      <div class="legend"><span><i style="background:#3b2f0c"></i>Power on</span><span><i style="background:repeating-linear-gradient(135deg,#3a1d14 0 3px,#4a2418 3px 6px);border:1px solid #ff6b4a"></i>Scheduled off</span></div>`;
    for (let i = 0; i < 7; i++) {
      const d = C.addDays(today, i);
      const d0 = C.toMs(d, '00:00'), d1 = d0 + C.DAY;
      const parts = ws.filter((w) => w.endMs > d0 && w.startMs < d1);
      const offMs = parts.reduce((s, w) => s + Math.min(w.endMs, d1) - Math.max(w.startMs, d0), 0);
      const blocks = parts.map((w) => {
        const a = (Math.max(w.startMs, d0) - d0) / C.DAY * 100, b = (Math.min(w.endMs, d1) - d0) / C.DAY * 100;
        return `<div class="blk" style="left:${a}%;width:${b - a}%"></div>`;
      }).join('');
      const nowMark = i === 0 ? `<div class="now" style="left:${(now - d0) / C.DAY * 100}%" title="now"></div>` : '';
      const chips = parts.map((w) => `<span class="chip">${t(w.startMs)}–${t(w.endMs)}${w.endMs > d1 ? ' +1' : ''}</span>`).join('') || '<span class="chip">No outages</span>';
      const label = parts.map((w) => `${t(w.startMs)} to ${t(w.endMs)}`).join(', ') || 'no outages';
      html += `<div class="day ${i === 0 ? 'today' : ''}">
        <div class="day-head"><b>${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : niceDate(d)}${i < 2 ? ` <span style="font-weight:400">${niceDate(d)}</span>` : ''}</b><span>${hours(offMs)} off</span></div>
        <div class="bar" role="img" aria-label="Scheduled off ${label}">${blocks}${nowMark}</div>
        <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
        <div class="slots">${chips}</div></div>`;
    }
    if (!ws.length) html += '<div class="empty">No load-shedding schedule is published for this group right now. If the power goes off, tap <b>Power went off</b> on the Now tab so neighbours are alerted.</div>';
    el.innerHTML = html;
    bindSwitcher(el);
  }

  // ---------- rendering: stats ----------
  function renderStats() {
    const el = $('#stats');
    const area = currentArea();
    if (!area) { el.innerHTML = '<div class="empty">Choose your area first.</div>'; return; }
    const s = S.stats;
    const dash = api.mode === 'server' ? '<a class="link-row" href="dashboard">Compare all areas and download the data (CSV) →</a>' : '';
    if (!s) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
    let html = `${S.saved.length > 1 ? areaSwitcher() : ''}<h2>${esc(area.name)} · last 7 days</h2>`;
    if (!s.enough) {
      html += `<div class="empty">Only ${s.households} household${s.households === 1 ? ' has' : 's have'} logged outages here. Figures appear once ${C.RULES.statsMinHouseholds} or more households report. Ask neighbours to tap <b>Power went off</b> and <b>Power is back</b>.</div>${dash}`;
      el.innerHTML = html; bindSwitcher(el); return;
    }
    const good = s.onSchedulePct >= 85;
    html += `<div class="tiles">
      <div class="tile"><div class="v" style="color:${good ? 'var(--on)' : 'var(--off)'}">${s.onSchedulePct}<small>%</small></div><div class="k">of outage time was on schedule</div></div>
      <div class="tile"><div class="v">${s.extraHoursPerDay}<small>h/day</small></div><div class="k">unscheduled outage time</div></div>
      <div class="tile"><div class="v">${s.lateRestoreMinPerDay}<small>min/day</small></div><div class="k">power restored late</div></div>
      <div class="tile"><div class="v">${s.actualHoursPerDay}<small>h/day</small></div><div class="k">actually off vs ${s.scheduledHoursPerDay} h scheduled</div></div>
    </div>
    <h2>Scheduled vs actual, hours off per day</h2>
    <div class="chart">
      <div class="legend"><span><i style="background:#6b6250"></i>Scheduled</span><span><i style="background:var(--off)"></i>Actual (typical household)</span></div>`;
    const max = Math.max(1, ...s.days.map((d) => Math.max(d.scheduledHours, d.actualHours || 0)));
    for (const d of s.days) {
      const lab = `${C.weekday(d.date)} ${Number(d.date.slice(8))}`;
      html += `<div class="crow" role="img" aria-label="${lab}: ${d.scheduledHours} hours scheduled, ${d.actualHours == null ? 'no reports' : d.actualHours + ' hours actual'}">
        <span class="d">${lab}</span>
        <div class="cbars"><div class="cbar s" style="width:${d.scheduledHours / max * 100}%"></div><div class="cbar a" style="width:${(d.actualHours || 0) / max * 100}%"></div></div>
        <span class="n">${d.actualHours == null ? '–' : d.actualHours}</span></div>`;
    }
    html += `</div><p class="fine">Based on ${s.households} households. Each figure is the median household, so one wrong report cannot skew it. Today counts only up to now.</p>${dash}`;
    el.innerHTML = html;
    bindSwitcher(el);
  }

  // ---------- rendering: alerts ----------
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const pushPossible = () => api.mode === 'server' && !!swReg && 'PushManager' in window && 'Notification' in window;

  function renderAlerts() {
    const el = $('#alerts');
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    let permRow;
    if (perm === 'granted') {
      const d = S.push ? 'Sent by the server, so they arrive even when Magetsi is closed.'
        : pushPossible() ? 'Reminders fire while Magetsi is open. Connecting to push for alerts when it is closed…'
          : 'Reminders fire while Magetsi is open or installed on your home screen.';
      permRow = `<div class="row"><div><div class="t">Notifications are on</div><div class="d">${d}</div></div><button class="btn ghost sm" id="testN">Test</button></div>`;
    } else if (perm === 'unsupported') {
      permRow = `<div class="row"><div><div class="t">This browser can't show notifications</div><div class="d">${isIOS() && !isStandalone() ? 'On iPhone, tap Share then "Add to Home Screen", and open Magetsi from there.' : 'Try Chrome on Android, or use SMS alerts below.'}</div></div></div>`;
    } else {
      permRow = `<div class="row"><div><div class="t">Turn on notifications</div><div class="d">${perm === 'denied' ? 'Blocked. Allow notifications for this site in browser settings.' : 'Needed for reminders.'}</div></div><button class="btn primary sm" id="askN" ${perm === 'denied' ? 'disabled' : ''}>Allow</button></div>`;
    }
    const names = S.saved.map(areaById).filter(Boolean).map((a) => esc(a.name)).join(', ');
    const seg = C.LEAD_CHOICES.map((m) => `<button data-lead="${m}" class="${settings.leadMin === m ? 'on' : ''}" aria-pressed="${settings.leadMin === m}">${m}m</button>`).join('');
    const sw = (key, title, desc) => `<div class="row"><div><div class="t">${title}</div><div class="d">${desc}</div></div>
      <label class="switch"><input type="checkbox" data-set="${key}" ${settings[key] ? 'checked' : ''} aria-label="${title}"><span></span></label></div>`;
    const fine = api.mode === 'server'
      ? (S.push ? '' : `<p class="fine">${S.pushErr ? 'Push is not available on this browser (' + esc(S.pushErr) + '). ' : ''}Without push, reminders come from your phone and need Magetsi open or installed.${isIOS() && !isStandalone() ? ' On iPhone, add Magetsi to your home screen first.' : ''}</p>`)
      : '<p class="fine">Demo mode: reminders are computed on your phone, so they need the app open. Run the server for push and SMS alerts.</p>';
    el.innerHTML = `<h2>Alerts</h2>
      <div class="card">${permRow}
        <div class="row"><div><div class="t">Areas</div><div class="d">${names || 'None yet'}</div></div><button class="btn ghost sm" id="editAreas">${S.saved.length ? 'Change' : 'Add'}</button></div>
      </div>
      <h2>When to remind me</h2>
      <div class="card">
        <div class="row"><div><div class="t">Before power goes off</div><div class="d">Time to charge, cook, save work</div></div><div class="seg" role="group" aria-label="Minutes before">${seg}</div></div>
        ${sw('restore', 'Before power comes back', '10 minutes before the scheduled restore')}
        ${sw('community', 'Unscheduled outages', `When ${C.RULES.communityMinReports}+ households in your area report power off outside the schedule`)}
        ${sw('quiet', 'Quiet hours', 'No alerts from 23:00 to 05:00')}
      </div>
      ${fine}
      ${smsSection()}`;
    el.querySelectorAll('[data-lead]').forEach((b) => b.onclick = () => { settings.leadMin = Number(b.dataset.lead); saveSettings(); renderAlerts(); });
    el.querySelectorAll('[data-set]').forEach((i) => i.onchange = () => { settings[i.dataset.set] = i.checked; saveSettings(); });
    $('#editAreas').onclick = openAreaDlg;
    const ask = $('#askN'); if (ask) ask.onclick = async () => { await Notification.requestPermission(); renderAlerts(); syncPush(); };
    const test = $('#testN'); if (test) test.onclick = testNotification;
    bindSms();
  }

  async function testNotification() {
    if (S.push) {
      try { await api.post('api/push/test', { device: deviceId }); toast('Test sent by the server. It should arrive in a few seconds.'); return; }
      catch (e) { toast(e.message); }
    }
    notify('Magetsi test', 'Notifications work. You will be reminded before outages.', 'test-' + Date.now(), true);
  }

  // ---------- SMS sign-up (for a basic phone, e.g. a relative's) ----------
  function areaOptions(selected) {
    let html = '', town = null;
    const savedAreas = S.saved.map(areaById).filter(Boolean);
    if (savedAreas.length) html += `<optgroup label="Your areas">${savedAreas.map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</optgroup>`;
    for (const a of S.areas) {
      if (a.town !== town) { if (town) html += '</optgroup>'; town = a.town; html += `<optgroup label="${esc(town)}">`; }
      html += `<option value="${a.id}" ${!savedAreas.length && a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`;
    }
    return html + (town ? '</optgroup>' : '');
  }
  function smsSection() {
    if (api.mode !== 'server' || !S.smsInfo) return '';
    const mine = LS.get('sms', null);
    let body;
    if (mine) {
      const what = [mine.daily && "today's times each morning", mine.before && `a reminder ${mine.before} min before each outage`].filter(Boolean).join(' and ');
      const a = areaById(mine.area);
      body = `<div class="row"><div><div class="t">${esc(mine.masked)}</div><div class="d">${a ? esc(a.name) : 'Area'}: ${what}</div></div><button class="btn ghost sm" id="smsStop">Stop</button></div>`;
    } else if (S.smsPending) {
      body = `<form class="pad" id="smsVerify">
        <label class="f" for="smsCode">Enter the 6-digit code sent to ${esc(S.smsPending.masked)}</label>
        <input id="smsCode" class="inp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required>
        <div class="err" id="smsErr" role="alert"></div>
        <div class="two"><button class="btn ghost" type="button" id="smsBack">Back</button><button class="btn primary" type="submit">Confirm</button></div></form>`;
    } else {
      body = `<form class="pad" id="smsForm">
        <label class="f" for="smsPhone">Mobile number</label>
        <input id="smsPhone" class="inp" type="tel" inputmode="tel" autocomplete="tel" placeholder="097 123 4567" required>
        <label class="f" for="smsArea">Area</label>
        <select id="smsArea" class="inp">${areaOptions(S.areaId)}</select>
        <label class="f" for="smsBefore">Reminder before power goes off</label>
        <select id="smsBefore" class="inp"><option value="30">30 minutes before</option><option value="60">1 hour before</option><option value="0">No reminder</option></select>
        <label class="check"><input type="checkbox" id="smsDaily" checked> Today's times every morning at 05:30</label>
        <div class="err" id="smsErr" role="alert"></div>
        <button class="btn primary" style="width:100%" type="submit">Send code</button></form>`;
    }
    const a = currentArea();
    const sc = S.smsInfo.shortcode
      ? `<p class="fine">From any phone, text <b>JOIN ${esc((a ? a.name : 'CHILENJE').toUpperCase())}</b> to <b>${esc(S.smsInfo.shortcode)}</b>. Text <b>TIMES</b> for today, <b>STOP</b> to end.</p>` : '';
    const test = S.smsInfo.driver === 'log' ? '<p class="fine">This server is in SMS test mode: messages go to the server log and the admin page, not to phones.</p>' : '';
    return `<h2>SMS for a basic phone</h2>
      <div class="card"><div class="row"><div class="d">Works on any phone, no data needed. Set it up for yourself or a relative. About 3 SMS a day.</div></div>${body}</div>${sc}${test}`;
  }
  function bindSms() {
    const err = (m) => { const e = $('#smsErr'); if (e) e.textContent = m; };
    const f = $('#smsForm');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const phone = C.normalizePhone($('#smsPhone').value);
      if (!phone) return err('Enter a Zambian mobile number, e.g. 097 123 4567');
      const daily = $('#smsDaily').checked, before = Number($('#smsBefore').value), area = Number($('#smsArea').value);
      if (!daily && !before) return err('Choose the morning SMS, a reminder, or both.');
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await api.post('api/sms/start', { device: deviceId, phone, area, daily, before });
        S.smsPending = { phone, masked: r.phone };
        renderAlerts();
        setTimeout(() => { const c = $('#smsCode'); if (c) c.focus(); }, 50);
      } catch (ex) { err(ex.message); btn.disabled = false; }
    };
    const v = $('#smsVerify');
    if (v) v.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('api/sms/verify', { device: deviceId, phone: S.smsPending.phone, code: $('#smsCode').value });
        LS.set('sms', { phone: S.smsPending.phone, masked: r.phone, area: r.area, daily: r.daily, before: r.before });
        S.smsPending = null; toast('SMS alerts are on'); renderAlerts();
      } catch (ex) { err(ex.message); }
    };
    const back = $('#smsBack'); if (back) back.onclick = () => { S.smsPending = null; renderAlerts(); };
    const stop = $('#smsStop');
    if (stop) stop.onclick = async () => {
      const mine = LS.get('sms', null);
      try { await api.post('api/sms/stop', { device: deviceId, phone: mine.phone }); toast('SMS alerts stopped'); }
      catch (ex) { toast(ex.message); }
      LS.set('sms', null); renderAlerts();
    };
  }

  function render() {
    const a = currentArea();
    $('#areaName').textContent = a ? a.name : 'Choose area';
    ({ home: renderHome, schedule: renderSchedule, stats: renderStats, alerts: renderAlerts })[S.tab]();
  }

  // ---------- data loading ----------
  async function refreshStatus() {
    if (!S.areaId) return;
    const id = S.areaId;
    try { const r = await api.status(id); if (id !== S.areaId) return; S.status = r.status; if (S.tab === 'home') renderHome(); checkAlerts(); } catch (e) { console.warn(e); }
  }
  async function refreshSchedule() {
    await Promise.all(S.saved.map(async (id) => {
      try { S.slotsBy[id] = (await api.schedule(id)).slots; } catch (e) { console.warn('schedule offline, using cache', e); }
    }));
    LS.set('cache.slotsBy', S.slotsBy);
  }
  async function refreshStats() {
    if (!S.areaId) return;
    const id = S.areaId;
    try { const r = await api.stats(id); if (id !== S.areaId) return; S.stats = r.stats; if (S.tab === 'stats') renderStats(); } catch (e) { console.warn(e); }
  }
  async function loadAll() { await refreshSchedule(); await refreshStatus(); render(); refreshStats(); }

  async function report(kind) {
    if (S.busy) return;
    S.busy = true;
    try {
      if (kind === 'off') { await api.off(S.areaId); toast('Thanks. Outage logged for ' + currentArea().name); }
      else { const r = await api.on(S.areaId); toast(`Power back. Outage lasted ${hours(r.outage.onMs - r.outage.offMs)}`); }
      await refreshStatus(); refreshStats();
    } catch (e) { toast(e.message); }
    finally { S.busy = false; }
  }

  // ---------- notifications ----------
  let swReg = null;
  async function notify(title, body, tag, force) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const sent = LS.get('sent', {});
    if (!force && sent[tag]) return;
    sent[tag] = Date.now();
    for (const k of Object.keys(sent)) if (Date.now() - sent[k] > 3 * C.DAY) delete sent[k];
    LS.set('sent', sent);
    const opts = { body, tag, icon: 'icon.svg', badge: 'icon.svg' };
    try { if (swReg) await swReg.showNotification(title, opts); else new Notification(title, opts); }
    catch (e) { try { new Notification(title, opts); } catch { /* ignore */ } }
  }
  // Local reminders: only when the server is not pushing them (demo mode, or push unavailable).
  function checkAlerts() {
    if (S.push) return;
    const now = Date.now();
    for (const id of S.saved) {
      const area = areaById(id);
      if (!area) continue;
      const status = id === S.areaId ? S.status : null;
      for (const a of C.dueAlerts({ area, slots: S.slotsBy[id] || [], status, settings, now })) notify(a.title, a.body, a.tag);
    }
  }

  // ---------- Web Push ----------
  function b64uToBytes(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  async function syncPush() {
    if (!pushPossible() || Notification.permission !== 'granted') { S.push = false; return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.req('api/push/key');
      let sub = await reg.pushManager.getSubscription();
      if (sub && LS.get('pushKey', null) !== publicKey) { await sub.unsubscribe().catch(() => {}); sub = null; } // server keys changed
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
      LS.set('pushKey', publicKey);
      await api.post('api/push/subscribe', { device: deviceId, subscription: sub.toJSON(), areas: S.saved, settings });
      S.push = true; S.pushErr = null;
    } catch (e) {
      console.warn('Web Push unavailable', e);
      S.push = false; S.pushErr = e.message;
    }
    if (S.tab === 'alerts') renderAlerts();
  }
  let pushTimer;
  function schedulePushSync() { clearTimeout(pushTimer); pushTimer = setTimeout(syncPush, 800); }

  // ---------- dialogs ----------
  function openAreaDlg() {
    const dlg = $('#areaDlg');
    const list = $('#areaList');
    const label = (a) => `${esc(a.name)}<span>${esc(a.town || '')} · ${esc(C.groupName(a.group_code))}</span>`;
    const draw = (q) => {
      const ql = q.trim().toLowerCase();
      let html = '';
      if (!ql && S.saved.length) {
        html += `<div class="lh">Your areas (${S.saved.length} of ${MAX_SAVED})</div>`;
        html += S.saved.map(areaById).filter(Boolean).map((a) => `<div class="saved-item"><button data-id="${a.id}" aria-current="${a.id === S.areaId}">${label(a)}</button><button class="rm" data-rm="${a.id}" aria-label="Stop following ${esc(a.name)}">×</button></div>`).join('');
      }
      const hits = S.areas.filter((a) => `${a.name} ${a.town || ''}`.toLowerCase().includes(ql));
      let town = null;
      for (const a of hits) {
        if (a.town !== town) { town = a.town; html += `<div class="lh">${esc(town || 'Areas')}</div>`; }
        html += `<button data-id="${a.id}" aria-current="${a.id === S.areaId}">${label(a)}</button>`;
      }
      if (!hits.length) html += '<p class="fine">No match. More areas will be added.</p>';
      list.innerHTML = html;
      list.querySelectorAll('button[data-id]').forEach((b) => b.onclick = () => { if (selectArea(Number(b.dataset.id))) dlg.close(); });
      list.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = () => { removeSaved(Number(b.dataset.rm)); draw($('#areaSearch').value); });
    };
    $('#areaSearch').value = '';
    draw('');
    $('#areaSearch').oninput = (e) => draw(e.target.value);
    dlg.showModal();
    setTimeout(() => $('#areaSearch').focus(), 50);
  }
  const toLocalInput = (ms) => `${C.lusakaDate(ms)}T${C.lusakaTime(ms)}`;
  const fromLocalInput = (v) => (v ? C.toMs(v.slice(0, 10), v.slice(11, 16)) : NaN);
  function openLogDlg() {
    const now = Date.now();
    $('#logOff').value = toLocalInput(now - 3 * C.HOUR);
    $('#logOn').value = toLocalInput(now - C.HOUR);
    $('#logOff').max = $('#logOn').max = toLocalInput(now);
    $('#logErr').textContent = '';
    $('#logDlg').showModal();
  }
  $('#logForm').onsubmit = async (e) => {
    e.preventDefault();
    const off = fromLocalInput($('#logOff').value), on = fromLocalInput($('#logOn').value);
    const err = C.validateManualOutage(off, on, Date.now());
    if (err) { $('#logErr').textContent = err; return; }
    try { await api.manual(S.areaId, off, on); $('#logDlg').close(); toast('Past outage saved'); refreshStats(); }
    catch (ex) { $('#logErr').textContent = ex.message; }
  };
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.onclick = () => b.closest('dialog').close());
  $('#areaBtn').onclick = openAreaDlg;

  // ---------- tabs ----------
  document.querySelectorAll('nav.tabs button').forEach((b) => b.onclick = () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('main section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + S.tab));
    render();
    if (S.tab === 'stats') refreshStats();
    window.scrollTo(0, 0);
  });

  // ---------- boot ----------
  (async function boot() {
    await pickBackend();
    if ('serviceWorker' in navigator && api.mode === 'server') {
      try { swReg = await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW not registered', e); }
    }
    try { S.areas = (await api.areas()).areas; LS.set('cache.areas', S.areas); } catch { S.areas = LS.get('cache.areas', []); }
    const townRank = (a) => { const i = C.TOWNS.indexOf(a.town); return i < 0 ? 99 : i; };
    S.areas.sort((a, b) => townRank(a) - townRank(b) || a.name.localeCompare(b.name));
    if (S.areas.length) {
      S.saved = S.saved.filter((id) => S.areas.some((a) => a.id === id)).slice(0, MAX_SAVED);
      LS.set('saved', S.saved);
      if (!S.saved.includes(S.areaId)) S.areaId = S.saved.length ? S.saved[0] : null;
    }
    render();
    if (S.areaId) await loadAll();
    if (api.mode === 'server') {
      api.req('api/sms/info').then((i) => { S.smsInfo = i; if (S.tab === 'alerts') renderAlerts(); }).catch(() => {});
      syncPush(); // keeps the server's copy of the subscription, areas and settings current
    }
    setInterval(tickCountdown, 1000);
    setInterval(refreshStatus, 30 * 1000);
    setInterval(refreshSchedule, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
  })();
})();
