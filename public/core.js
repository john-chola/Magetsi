/*
 * Magetsi core: schedule maths shared by the browser (demo mode + UI) and the Node server.
 * All schedule times are Lusaka local time (UTC+2, no daylight saving).
 * Outage timestamps are milliseconds since epoch (UTC).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MagetsiCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OFFSET_MIN = 120; // Africa/Lusaka = UTC+2
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // Thresholds that the plan doc commits to
  const RULES = {
    communityMinReports: 2,     // households reporting off before we call it an area outage
    communityWindowMs: 45 * MIN,
    statsMinHouseholds: 3,      // hide adherence figures below this
    maxOutageMs: 24 * HOUR,     // auto-close + flag after this
    maxManualAgeMs: 7 * DAY,
    writesPerHour: 20,
  };

  // ---------- time helpers (Lusaka local) ----------
  const lusakaDate = (ms) => new Date(ms + OFFSET_MIN * MIN).toISOString().slice(0, 10);
  const lusakaTime = (ms) => new Date(ms + OFFSET_MIN * MIN).toISOString().slice(11, 16);
  const lusakaHour = (ms) => new Date(ms + OFFSET_MIN * MIN).getUTCHours();
  const toMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00Z`) - OFFSET_MIN * MIN;
  const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const weekday = (date) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${date}T00:00:00Z`).getUTCDay()];

  const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  const isValidTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s) || s === '24:00';

  // ---------- schedule windows ----------
  /** A slot {date, start, end}; end <= start means it runs past midnight. */
  function slotWindow(slot) {
    const startMs = toMs(slot.date, slot.start);
    let endMs = slot.end === '24:00' ? toMs(addDays(slot.date, 1), '00:00') : toMs(slot.date, slot.end);
    if (endMs <= startMs) endMs += DAY;
    return { ...slot, startMs, endMs };
  }

  /** Sorted, merged [startMs, endMs] windows (overlapping or touching slots join). */
  function mergedWindows(slots) {
    const ws = slots.map(slotWindow).sort((a, b) => a.startMs - b.startMs);
    const out = [];
    for (const w of ws) {
      const last = out[out.length - 1];
      if (last && w.startMs <= last.endMs) last.endMs = Math.max(last.endMs, w.endMs);
      else out.push({ startMs: w.startMs, endMs: w.endMs });
    }
    return out;
  }

  /** Scheduled state at `now`: whether off, and when the next change happens. */
  function scheduleState(slots, now) {
    const ws = mergedWindows(slots);
    const cur = ws.find((w) => w.startMs <= now && now < w.endMs);
    if (cur) return { scheduledOff: true, window: cur, nextChange: 'on', nextChangeMs: cur.endMs, nextWindow: ws.find((w) => w.startMs > now) || null };
    const next = ws.find((w) => w.startMs > now) || null;
    return { scheduledOff: false, window: null, nextChange: next ? 'off' : null, nextChangeMs: next ? next.startMs : null, nextWindow: next };
  }

  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const round1 = (x) => Math.round(x * 10) / 10;

  // ---------- live status ----------
  /**
   * outages: [{device_id, offMs, onMs|null, flagged}]
   * Returns the combined picture the status card shows.
   */
  function computeStatus({ slots, outages, now, deviceId }) {
    const sched = scheduleState(slots, now);
    const open = outages.filter((o) => o.onMs == null && !o.flagged && now - o.offMs < RULES.maxOutageMs);
    const offNow = new Set(open.map((o) => o.device_id)).size;
    const recentOff = new Set(open.filter((o) => now - o.offMs <= RULES.communityWindowMs).map((o) => o.device_id)).size;
    const recentlyBack = new Set(outages.filter((o) => o.onMs != null && now - o.onMs <= RULES.communityWindowMs).map((o) => o.device_id)).size;
    const communityOff = offNow >= RULES.communityMinReports;
    const mine = deviceId ? outages.find((o) => o.device_id === deviceId && o.onMs == null && !o.flagged) || null : null;

    let likely; // what we tell the user is most probably true
    if (communityOff) likely = 'off';
    else if (sched.scheduledOff && recentlyBack >= RULES.communityMinReports) likely = 'on';
    else likely = sched.scheduledOff ? 'off' : 'on';

    return {
      now,
      ...sched,
      likely,
      community: { offNow, recentOff, recentlyBack, unscheduled: communityOff && !sched.scheduledOff },
      myOpenOutage: mine,
    };
  }

  // ---------- adherence ----------
  /**
   * How well did the real outages (as households logged them) match the schedule?
   * Per household: inside-slot minutes, outside-slot (extra) minutes, late-restore minutes.
   * Area figures = median across households, so one bad reporter can't skew it.
   */
  function adherence({ slots, outages, fromMs, toMs: endMs }) {
    const ws = mergedWindows(slots);
    const scheduledMs = ws.reduce((t, w) => t + overlap(w.startMs, w.endMs, fromMs, endMs), 0);
    const per = new Map();
    const daysPer = new Map(); // date -> device -> actualMs

    for (const o of outages) {
      if (o.flagged) continue;
      const a = Math.max(o.offMs, fromMs);
      const b = Math.min(o.onMs ?? endMs, endMs);
      if (b <= a) continue;
      const d = per.get(o.device_id) || { total: 0, inside: 0, late: 0 };
      d.total += b - a;
      for (const w of ws) d.inside += overlap(a, b, w.startMs, w.endMs);
      // late restore: the outage was running when a window ended and kept going
      for (let i = 0; i < ws.length; i++) {
        const w = ws[i];
        if (w.endMs <= a || w.endMs >= b) continue;
        if (o.offMs >= w.endMs) continue;
        const nextStart = ws[i + 1] ? ws[i + 1].startMs : Infinity;
        d.late += Math.min(b, nextStart) - w.endMs;
      }
      per.set(o.device_id, d);

      // split across Lusaka days for the daily chart
      let t = a;
      while (t < b) {
        const date = lusakaDate(t);
        const dayEnd = toMs(addDays(date, 1), '00:00');
        const seg = Math.min(b, dayEnd) - t;
        if (!daysPer.has(date)) daysPer.set(date, new Map());
        const m = daysPer.get(date);
        m.set(o.device_id, (m.get(o.device_id) || 0) + seg);
        t += seg;
      }
    }

    const hh = [...per.values()];
    const households = hh.length;
    const enough = households >= RULES.statsMinHouseholds;
    const nDays = Math.max(1, (endMs - fromMs) / DAY);

    // daily scheduled vs actual (median household)
    const days = [];
    for (let date = lusakaDate(fromMs); toMs(date, '00:00') < endMs; date = addDays(date, 1)) {
      const d0 = Math.max(toMs(date, '00:00'), fromMs);
      const d1 = Math.min(toMs(addDays(date, 1), '00:00'), endMs);
      const sch = ws.reduce((t, w) => t + overlap(w.startMs, w.endMs, d0, d1), 0);
      const m = daysPer.get(date);
      days.push({
        date,
        scheduledHours: round1(sch / HOUR),
        actualHours: m ? round1(median([...m.values()]) / HOUR) : null,
        reporters: m ? m.size : 0,
      });
    }

    return {
      households,
      enough,
      fromMs,
      toMs: endMs,
      scheduledHoursPerDay: round1(scheduledMs / HOUR / nDays),
      actualHoursPerDay: enough ? round1(median(hh.map((d) => d.total)) / HOUR / nDays) : null,
      extraHoursPerDay: enough ? round1(median(hh.map((d) => d.total - d.inside)) / HOUR / nDays) : null,
      onSchedulePct: enough ? Math.round(median(hh.map((d) => (d.total ? (100 * d.inside) / d.total : 100)))) : null,
      lateRestoreMinPerDay: enough ? Math.round(median(hh.map((d) => d.late)) / MIN / nDays) : null,
      days,
    };
  }

  // ---------- validation ----------
  function validateManualOutage(offMs, onMs, now) {
    if (!Number.isFinite(offMs) || !Number.isFinite(onMs)) return 'Both times are required.';
    if (onMs <= offMs) return 'Power back must be after power off.';
    if (onMs > now + MIN) return 'You can only log outages that already ended.';
    if (onMs - offMs > RULES.maxOutageMs) return 'An outage longer than 24 hours cannot be logged by hand.';
    if (now - offMs > RULES.maxManualAgeMs) return 'Only outages from the last 7 days can be logged.';
    return null;
  }

  // ---------- alert rules (the same rules run on the phone and on the server) ----------
  const DEFAULT_SETTINGS = { leadMin: 30, restore: true, community: true, quiet: true };
  const LEAD_CHOICES = [10, 30, 60];
  const isQuietHour = (ms) => { const h = lusakaHour(ms); return h >= 23 || h < 5; };

  /** Clean user-supplied alert settings. */
  function cleanSettings(s) {
    s = s || {};
    const out = { ...DEFAULT_SETTINGS };
    if (LEAD_CHOICES.includes(Number(s.leadMin))) out.leadMin = Number(s.leadMin);
    for (const k of ['restore', 'community', 'quiet']) if (typeof s[k] === 'boolean') out[k] = s[k];
    return out;
  }

  /**
   * Notifications due at `now` for one area: [{tag, title, body}].
   * The tag is stable for one event, so callers send each tag once.
   */
  function dueAlerts({ area, slots, status, settings, now }) {
    const s = cleanSettings(settings);
    if (s.quiet && isQuietHour(now)) return [];
    const out = [];
    const lead = s.leadMin * MIN;
    for (const w of mergedWindows(slots)) {
      if (now >= w.startMs - lead && now < w.startMs) {
        out.push({
          tag: `off-${area.id}-${w.startMs}`,
          title: `Power off at ${lusakaTime(w.startMs)} in ${area.name}`,
          body: `Scheduled until ${lusakaTime(w.endMs)}. About ${Math.max(1, Math.round((w.startMs - now) / MIN))} minutes to go. Charge your phone now.`,
        });
      }
      if (s.restore && now >= w.endMs - 10 * MIN && now < w.endMs) {
        out.push({
          tag: `on-${area.id}-${w.endMs}`,
          title: `Power due back at ${lusakaTime(w.endMs)}`,
          body: `${area.name}: scheduled restore. Tap "Power is back" when it returns.`,
        });
      }
    }
    if (s.community && status && status.community && status.community.unscheduled) {
      out.push({
        tag: `unsched-${area.id}-${lusakaDate(now)}-${lusakaHour(now)}`,
        title: `Unscheduled outage in ${area.name}`,
        body: `${status.community.offNow} households report power off. It is not on the schedule.`,
      });
    }
    return out;
  }

  // ---------- SMS ----------
  /** Zambian mobile numbers to +260XXXXXXXXX, otherwise null. */
  function normalizePhone(input) {
    const d = String(input || '').replace(/[\s().-]/g, '');
    const m = d.match(/^(?:\+?260|0)?([79]\d{8})$/);
    return m ? '+260' + m[1] : null;
  }

  /** Rest of today's outage windows as short text, e.g. "06:00-10:00, 22:00-02:00". */
  function todayWindowsText(slots, now) {
    const d1 = toMs(addDays(lusakaDate(now), 1), '00:00');
    return mergedWindows(slots).filter((w) => w.endMs > now && w.startMs < d1)
      .map((w) => `${lusakaTime(w.startMs)}-${lusakaTime(w.endMs)}`).join(', ');
  }

  /**
   * SMS due at `now` for one subscriber: [{tag, text}]. Each fits in one SMS, because SMS costs money.
   * sub: {daily: 0|1, before_min: 0 or minutes}
   *  - daily: today's times, sent once between 05:30 and 07:00
   *  - before: a reminder before each outage, never 23:00 to 05:00
   */
  function smsDue({ area, slots, sub, now }) {
    const out = [];
    const date = lusakaDate(now);
    if (sub.daily && now >= toMs(date, '05:30') && now < toMs(date, '07:00')) {
      const list = todayWindowsText(slots, now);
      out.push({
        tag: `sms-daily-${area.id}-${date}`,
        text: list ? `Magetsi: ${area.name} power off today ${list}. Reply STOP to end.`
          : `Magetsi: no load-shedding scheduled in ${area.name} for the rest of today. Reply STOP to end.`,
      });
    }
    const lead = Number(sub.before_min) * MIN;
    if (lead > 0 && !isQuietHour(now)) {
      for (const w of mergedWindows(slots)) {
        if (now >= w.startMs - lead && now < w.startMs) {
          out.push({ tag: `sms-off-${area.id}-${w.startMs}`, text: `Magetsi: power off in ${area.name} at ${lusakaTime(w.startMs)}, back ${lusakaTime(w.endMs)}. Charge your phone now.` });
        }
      }
    }
    return out;
  }

  /**
   * Inbound SMS: JOIN <area> | STOP | TIMES | HELP. A bare area name means JOIN.
   * Returns {cmd: 'join'|'stop'|'times'|'help'|'ambiguous'|'unknown', area?, options?}
   */
  function parseSmsCommand(text, areas) {
    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    let words = norm(text).split(' ').filter(Boolean);
    if (words[0] === 'MAGETSI') words = words.slice(1); // shared shortcodes put a keyword first
    if (!words.length) return { cmd: 'help' };
    const [w0, ...rest] = words;
    if (['STOP', 'END', 'QUIT', 'UNSUBSCRIBE', 'CANCEL'].includes(w0)) return { cmd: 'stop' };
    if (['HELP', 'INFO'].includes(w0)) return { cmd: 'help' };
    if (['TIMES', 'TODAY', 'TIME'].includes(w0)) return { cmd: 'times' };
    const q = (['JOIN', 'START', 'SUB', 'SUBSCRIBE', 'AREA'].includes(w0) ? rest : words).join(' ');
    if (!q) return { cmd: 'help' };
    if (/^\d+$/.test(q)) { const a = areas.find((x) => x.id === Number(q)); return a ? { cmd: 'join', area: a } : { cmd: 'unknown' }; }
    for (const match of [(n) => n === q, (n) => n.startsWith(q), (n) => n.includes(q)]) {
      const hits = areas.filter((a) => match(norm(a.name)));
      if (hits.length === 1) return { cmd: 'join', area: hits[0] };
      if (hits.length > 1) return { cmd: 'ambiguous', options: hits.slice(0, 4) };
    }
    return { cmd: 'unknown' };
  }

  // ---------- public dashboard ----------
  function dashboardCsv(rows, meta) {
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [
      `# Magetsi schedule adherence ${meta.from} to ${meta.to} (Lusaka time). Figures are the median reporting household; blank when fewer than ${RULES.statsMinHouseholds} households reported.`,
      'area_id,area,town,group,households,enough_reports,on_schedule_pct,extra_hours_per_day,late_restore_min_per_day,actual_hours_per_day,scheduled_hours_per_day',
    ];
    for (const r of rows) {
      lines.push([r.id, r.name, r.town, r.group_code, r.households, r.enough ? 1 : 0, r.onSchedulePct, r.extraHoursPerDay,
        r.lateRestoreMinPerDay, r.actualHoursPerDay, r.scheduledHoursPerDay].map(cell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  /** Parse admin CSV: group,date,start,end (header optional). Returns {slots, errors}. */
  function parseScheduleCsv(text, knownGroups) {
    const slots = [];
    const errors = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) return;
      const [group, date, start, end] = raw.split(',').map((s) => s.trim());
      if (i === 0 && /^group$/i.test(group)) return;
      const g = (group || '').toUpperCase();
      if (knownGroups && !knownGroups.includes(g)) return errors.push(`Line ${i + 1}: unknown group "${group}"`);
      if (!isValidDate(date)) return errors.push(`Line ${i + 1}: bad date "${date}" (use YYYY-MM-DD)`);
      if (!isValidTime(start) || !isValidTime(end)) return errors.push(`Line ${i + 1}: bad time (use HH:MM)`);
      if (start === end) return errors.push(`Line ${i + 1}: start and end are the same`);
      slots.push({ group_code: g, date, start, end });
    });
    return { slots, errors };
  }

  // ---------- seed data (Lusaka) ----------
  const GROUPS = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => ({ code: c, name: `Group ${c}` }));

  // Illustrative mapping only: ZESCO's real area-to-group list must replace this.
  // Ids are stable: never renumber or reorder, only append.
  const TOWN_AREAS = {
    Lusaka: [
      ['Avondale', 'A'], ['Bauleni', 'D'], ['Chainda', 'E'], ['Chalala', 'C'], ['Chawama', 'F'],
      ['Chelston', 'A'], ['Chilenje', 'B'], ['Chudleigh', 'C'], ['Emmasdale', 'D'], ['Garden', 'E'],
      ['Ibex Hill', 'F'], ['Jack Compound', 'A'], ['Kabulonga', 'B'], ['Kabwata', 'C'], ['Kalingalinga', 'D'],
      ['Kamwala', 'E'], ['Kanyama', 'F'], ['Libala', 'A'], ['Makeni', 'B'], ['Matero', 'C'],
      ['Mtendere', 'D'], ['Mutendere East', 'E'], ['Northmead', 'F'], ['Olympia', 'A'], ['Rhodes Park', 'B'],
      ['Roma', 'C'], ['Woodlands', 'D'], ['Lilayi', 'E'], ['Chunga', 'F'], ['PHI', 'B'],
    ],
    Kitwe: [['Nkana East', 'A'], ['Nkana West', 'B'], ['Parklands', 'C'], ['Riverside', 'D'], ['Chimwemwe', 'E'], ['Buchi', 'F'], ['Kwacha', 'A'], ['Ndeke', 'B']],
    Ndola: [['Kansenshi', 'C'], ['Itawa', 'D'], ['Northrise', 'E'], ['Chifubu', 'F'], ['Kabushi', 'A'], ['Masala', 'B'], ['Twapia', 'C']],
    Kabwe: [['Bwacha', 'D'], ['Makandanyama', 'E'], ['Katondo', 'F'], ['Kasanda', 'A'], ['Mine Township', 'B']],
    Livingstone: [['Dambwa', 'C'], ['Linda', 'D'], ['Maramba', 'E'], ['Libuyu', 'F'], ['Nottie Broadie', 'A']],
  };
  const TOWNS = Object.keys(TOWN_AREAS);
  const AREAS = [];
  for (const town of TOWNS) for (const [name, group_code] of TOWN_AREAS[town]) AREAS.push({ id: AREAS.length + 1, name, town, group_code });

  // Six 4-hour bands; each group is off for two bands a day (8 h), rotating daily.
  const BANDS = [['02:00', '06:00'], ['06:00', '10:00'], ['10:00', '14:00'], ['14:00', '18:00'], ['18:00', '22:00'], ['22:00', '02:00']];
  function rotationSlots(startDate, days) {
    const out = [];
    for (let d = 0; d < days; d++) {
      const date = addDays(startDate, d);
      GROUPS.forEach((g, gi) => {
        for (const k of [0, 3]) {
          const [start, end] = BANDS[(gi + d + k) % 6];
          out.push({ group_code: g.code, date, start, end, source: 'demo-rotation' });
        }
      });
    }
    return out;
  }

  // Deterministic pseudo-random so the demo looks the same each run
  function prng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  /** Synthetic household reports for the past `days`: mostly on schedule, some late, a few unscheduled. */
  function demoOutages(areas, slots, now, days = 7) {
    const rnd = prng(42);
    const out = [];
    const from = now - days * DAY;
    for (const area of areas) {
      const hh = 3 + Math.floor(rnd() * 4); // 3..6 households per area
      const ws = mergedWindows(slots.filter((s) => s.group_code === area.group_code));
      // area "character": some areas get worse service
      const lateness = rnd() < 0.35 ? 90 : 20;
      for (let h = 0; h < hh; h++) {
        const device_id = `seed-${area.id}-${h}`;
        for (const w of ws) {
          if (w.startMs < from || w.endMs > now) continue;
          if (rnd() < 0.05) continue; // household didn't report this one
          const offMs = w.startMs + Math.round((rnd() * 10 - 2) * MIN);
          const onMs = w.endMs + Math.round(rnd() * lateness * MIN);
          out.push({ area_id: area.id, device_id, offMs, onMs, manual: 0, flagged: 0 });
        }
        // a couple of unscheduled outages per area per week, shared by most households
        // (generated once per area below)
      }
      const extra = 1 + Math.floor(rnd() * 3);
      for (let e = 0; e < extra; e++) {
        const startMs = from + Math.floor(rnd() * (days - 1)) * DAY + Math.floor(rnd() * 20) * HOUR;
        if (ws.some((w) => overlap(startMs, startMs + 2 * HOUR, w.startMs, w.endMs) > 0)) continue;
        const dur = (1 + rnd() * 2) * HOUR;
        for (let h = 0; h < hh; h++) {
          if (rnd() < 0.3) continue;
          out.push({ area_id: area.id, device_id: `seed-${area.id}-${h}`, offMs: startMs + Math.round(rnd() * 5 * MIN), onMs: startMs + dur, manual: 0, flagged: 0 });
        }
      }
    }
    return out;
  }

  return {
    RULES, MIN, HOUR, DAY, OFFSET_MIN,
    lusakaDate, lusakaTime, lusakaHour, toMs, addDays, weekday, isValidDate, isValidTime,
    slotWindow, mergedWindows, scheduleState, computeStatus, adherence, median,
    validateManualOutage, parseScheduleCsv,
    DEFAULT_SETTINGS, LEAD_CHOICES, isQuietHour, cleanSettings, dueAlerts,
    normalizePhone, todayWindowsText, smsDue, parseSmsCommand, dashboardCsv,
    GROUPS, TOWNS, AREAS, BANDS, rotationSlots, demoOutages,
  };
});
