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

  // ---------- groups and areas ----------
  // ZESCO numbers its load-management groups per town: Lusaka's Group A and Kitwe's Group A are
  // different feeders on different times. Codes are town prefix + letter, e.g. LSK-C.
  const TOWN_GROUPS = {
    Lusaka: { prefix: 'LSK', letters: ['A', 'B', 'C', 'D', 'E'] },
    Kitwe: { prefix: 'KIT', letters: ['A', 'B', 'C'] },
    Ndola: { prefix: 'NDL', letters: ['A', 'B', 'C', 'D'] },
    Kabwe: { prefix: 'KBW', letters: ['A', 'B', 'C', 'D'] },
    Livingstone: { prefix: 'LVS', letters: ['A', 'B', 'C'] },
  };
  const GROUPS = [];
  for (const [town, { prefix, letters }] of Object.entries(TOWN_GROUPS)) {
    for (const l of letters) GROUPS.push({ code: `${prefix}-${l}`, name: `Group ${l}`, town });
  }
  const groupCode = (town, letter) => `${TOWN_GROUPS[town].prefix}-${letter}`;
  /** "Group C" for LSK-C; unknown codes are shown as they are. */
  const groupName = (code) => (GROUPS.find((g) => g.code === code) || { name: `Group ${code}` }).name;

  // Area -> group, from ZESCO's load management schedule of March 2024 (the latest published at the
  // time of writing). ZESCO lists by feeder, so a few neighbourhoods are split across groups street by
  // street; each is listed here under the group that covers most of it.
  // Kabwe: ZESCO lists the same areas under Groups A and B, which are always scheduled together;
  // they are filed under A.
  // Ids are stable: never renumber or reuse one. Append new areas with the next free id.
  // Ids 12, 30, 47, 50 and 54 belonged to an earlier illustrative list and are retired.
  const TOWN_AREAS = {
    Lusaka: [
      [1, 'Avondale', 'E'], [2, 'Bauleni', 'D'], [3, 'Chainda', 'B'], [4, 'Chalala', 'E'], [5, 'Chawama', 'D'],
      [6, 'Chelstone', 'D'], [7, 'Chilenje', 'C'], [8, 'Chudleigh', 'C'], [9, 'Emmasdale', 'D'], [10, 'Garden', 'E'],
      [11, 'Ibex Hill', 'B'], [13, 'Kabulonga', 'D'], [14, 'Kabwata', 'D'], [15, 'Kalingalinga', 'B'], [16, 'Kamwala', 'B'],
      [17, 'Kanyama', 'D'], [18, 'Libala', 'B'], [19, 'Makeni', 'C'], [20, 'Matero', 'D'], [21, 'Mtendere', 'D'],
      [22, 'Mtendere East', 'E'], [23, 'Northmead', 'D'], [24, 'Olympia', 'D'], [25, 'Rhodes Park', 'B'], [26, 'Roma', 'D'],
      [27, 'Woodlands', 'E'], [28, 'Lilayi', 'B'], [29, 'Chunga', 'E'],
      [56, 'Lusaka West', 'A'], [57, 'Light Industrial Area', 'A'], [58, 'Chinika Industrial Area', 'A'], [59, 'Soweto Market', 'A'],
      [60, 'City Market', 'A'], [61, 'State Lodge', 'B'], [62, 'New Kasama', 'B'], [63, 'Fairview', 'C'], [64, 'Showgrounds', 'B'],
      [65, 'Lusaka Town Centre', 'B'], [66, 'John Laing', 'B'], [67, 'Mass Media', 'B'], [68, 'Libala South', 'C'], [69, 'York Farm', 'B'],
      [70, 'Kaunda Square', 'D'], [71, 'Hellen Kaunda', 'D'], [72, 'Kabulonga Extension', 'D'], [73, 'Makeni Villa', 'D'], [74, 'George', 'D'],
      [75, 'Lilanda', 'E'], [76, 'Chipata Township', 'D'], [77, 'Kabanana', 'D'], [78, 'Chamba Valley', 'E'], [79, 'Chelstone Green', 'E'],
      [80, 'Kalikiliki', 'E'], [81, 'Kamanga', 'E'], [82, 'Longacres', 'E'], [83, 'Salama Park', 'E'], [84, 'Meanwood Ndeke', 'E'],
      [85, 'Silverest', 'E'], [86, 'Vorna Valley', 'E'], [87, 'Waterfalls', 'E'], [88, 'Chibolya', 'E'], [89, 'Misisi', 'E'],
      [90, 'Ngombe', 'E'], [91, 'Kamwala South', 'E'], [92, 'Jesmondine', 'C'], [93, 'Marshlands', 'C'], [94, 'New Chilenje', 'C'],
      [95, 'Nyumba Yanga', 'C'], [96, 'Woodlands Extension', 'C'], [97, 'Rockfield', 'C'], [98, 'Chazanga', 'C'], [99, 'Roma (Zambezi Road)', 'E'],
      [100, 'Meanwood Kwamwena', 'D'],
    ],
    Kitwe: [
      [31, 'Nkana East', 'B'], [32, 'Nkana West', 'C'], [33, 'Parklands', 'B'], [34, 'Riverside', 'B'], [35, 'Chimwemwe', 'B'],
      [36, 'Buchi', 'A'], [37, 'Kwacha', 'B'], [38, 'Ndeke', 'C'],
      [101, 'Wusakile', 'C'], [102, 'Chamboli', 'C'], [103, 'Mindolo', 'C'], [104, 'Mulenga Compound', 'C'], [105, 'Chipata Compound', 'C'],
      [106, 'Kitwe CBD', 'C'], [107, 'Kalengwa', 'C'], [108, 'Kamitondo', 'A'], [109, 'Garneton', 'A'], [110, 'Twatasha', 'A'],
      [111, 'Racecourse', 'A'], [112, 'Freetown', 'A'], [113, 'Buyantanshi', 'A'], [114, 'Chachacha', 'A'], [115, 'Kawama', 'A'],
      [116, 'Kakolo', 'A'], [117, 'Kwacha East', 'A'], [118, 'Bulangililo', 'B'], [119, 'Kapoto', 'B'], [120, 'Changanamai', 'B'],
      [121, 'Kitwe West', 'B'], [122, 'Kamakonde', 'B'], [123, 'Zambia Township', 'A'],
    ],
    Ndola: [
      [39, 'Kansenshi', 'B'], [40, 'Itawa', 'B'], [41, 'Northrise', 'A'], [42, 'Chifubu', 'B'], [43, 'Kabushi', 'A'],
      [44, 'Masala', 'B'], [45, 'Twapia', 'A'],
      [124, 'Ndola Villa', 'A'], [125, 'Pamodzi', 'A'], [126, 'Nkwazi', 'A'], [127, 'Kawama Township', 'A'], [128, 'Kaniki', 'A'],
      [129, 'Chipulukusu', 'A'], [130, 'Lubuto', 'A'], [131, 'Mushili', 'A'], [132, 'Kaloko', 'A'], [133, 'Kantolomba', 'A'],
      [134, 'Hillcrest', 'B'], [135, 'Ndeke (Ndola)', 'B'], [136, 'Kalewa', 'B'], [137, 'Dola Hill', 'B'], [138, 'Peter Singogo', 'B'],
      [139, 'Mitengo', 'B'], [140, 'Mapalo', 'B'], [141, 'Jacaranda Villa', 'B'], [142, 'Ndola Town Centre', 'C'],
      [143, 'Ndola Industrial Area', 'C'], [144, 'Broadway', 'C'], [145, 'Kanini', 'D'], [146, 'Skyways', 'D'], [147, 'Fatima', 'D'],
    ],
    Kabwe: [
      [46, 'Bwacha', 'A'], [48, 'Katondo', 'D'], [49, 'Kasanda', 'A'],
      [148, 'Ngungu', 'A'], [149, 'Chimanimani', 'A'], [150, 'Natuseko', 'A'], [151, 'Makululu', 'A'], [152, 'Mukobeko', 'C'],
      [153, 'Luangwa', 'C'], [154, 'Kalonga', 'C'], [155, 'Nkrumah', 'C'], [156, 'Lukanga', 'C'], [157, 'Makwati', 'C'],
      [158, 'Highridge', 'D'], [159, 'Chowa', 'D'], [160, 'Kabwe Town Centre', 'D'],
    ],
    Livingstone: [
      [51, 'Dambwa', 'A'], [52, 'Linda', 'B'], [53, 'Maramba', 'B'], [55, 'Nottie Broadie', 'A'],
      [161, 'Highlands', 'A'], [162, 'Ellaine Brittle', 'A'], [163, 'Dambwa Industrial Area', 'B'], [164, 'Fairmount', 'B'],
      [165, 'Ngwenya', 'B'], [166, 'Livingstone Town Centre', 'B'], [167, 'Mukuni', 'C'], [168, 'Nakatindi', 'C'], [169, 'Kazungula Road', 'C'],
    ],
  };
  const RETIRED_AREA_IDS = [12, 30, 47, 50, 54];
  const TOWNS = Object.keys(TOWN_AREAS);
  const AREAS = [];
  for (const town of TOWNS) {
    for (const [id, name, letter] of TOWN_AREAS[town]) AREAS.push({ id, name, town, group_code: groupCode(town, letter) });
  }

  // ---------- ZESCO weekly patterns -> slots ----------
  const cellLetters = (cell) => String(cell).split(/[&+,]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  /**
   * ZESCO publishes a grid: time bands down the side, dates across, a group letter in each cell,
   * repeating every few weeks. A pattern captures one town's grid:
   *   { start: '2024-03-11', days: 7, bands: ['05:00-13:00', ...], cycle: [['C', 'D', 'E'], ['D', 'E', 'C'], ...] }
   * cycle[k][i] is the group(s) off in bands[i] during the k-th block of `days` days from `start`
   * ('A&B' for two groups, '' for none). The cycle repeats before and after the published dates.
   * Returns {slots, errors}; slot group codes carry the town prefix (LSK-C).
   */
  function patternSlots(town, pattern, fromDate, toDate) {
    const tg = TOWN_GROUPS[town];
    if (!tg) return { slots: [], errors: [`Unknown town "${town}" (known: ${TOWNS.join(', ')})`] };
    const errors = [];
    const { start, bands, cycle } = pattern || {};
    const days = pattern && pattern.days != null ? pattern.days : 7;
    if (!isValidDate(start)) errors.push(`${town}: start must be a date like 2024-03-11`);
    if (!Number.isInteger(days) || days < 1) errors.push(`${town}: days must be a whole number`);
    if (!Array.isArray(bands) || !bands.length) errors.push(`${town}: bands is missing`);
    if (!Array.isArray(cycle) || !cycle.length) errors.push(`${town}: cycle is missing`);
    if (!isValidDate(fromDate) || !isValidDate(toDate) || toDate < fromDate) errors.push('from and to must be dates (YYYY-MM-DD), from first');
    if (errors.length) return { slots: [], errors };
    const times = bands.map((b, i) => {
      const [s, e] = String(b).split('-').map((x) => x.trim());
      if (!isValidTime(s) || !isValidTime(e) || s === e) errors.push(`${town}: band ${i + 1} "${b}" should look like 05:00-13:00`);
      return [s, e];
    });
    cycle.forEach((row, k) => {
      if (!Array.isArray(row) || row.length !== bands.length) return errors.push(`${town}: cycle block ${k + 1} needs one entry per band (${bands.length})`);
      for (const cell of row) for (const l of cellLetters(cell)) {
        if (!tg.letters.includes(l)) errors.push(`${town}: cycle block ${k + 1} has unknown group "${l}"`);
      }
    });
    if (errors.length) return { slots: [], errors };

    const slots = [];
    const startMs = toMs(start, '12:00');
    for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
      const offset = Math.round((toMs(d, '12:00') - startMs) / DAY);
      const k = ((Math.floor(offset / days) % cycle.length) + cycle.length) % cycle.length;
      cycle[k].forEach((cell, i) => {
        for (const l of cellLetters(cell)) slots.push({ group_code: groupCode(town, l), date: d, start: times[i][0], end: times[i][1] });
      });
    }
    return { slots, errors };
  }

  // ---------- demo data ----------
  // Six 4-hour bands; in each town every group is off for two bands a day (8 h), rotating daily.
  const BANDS = [['02:00', '06:00'], ['06:00', '10:00'], ['10:00', '14:00'], ['14:00', '18:00'], ['18:00', '22:00'], ['22:00', '02:00']];
  function rotationSlots(startDate, days) {
    const out = [];
    for (let d = 0; d < days; d++) {
      const date = addDays(startDate, d);
      for (const town of TOWNS) {
        TOWN_GROUPS[town].letters.forEach((l, gi) => {
          for (const k of [0, 3]) {
            const [start, end] = BANDS[(gi + d + k) % 6];
            out.push({ group_code: groupCode(town, l), date, start, end, source: 'demo-rotation' });
          }
        });
      }
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
    TOWN_GROUPS, GROUPS, groupCode, groupName, TOWNS, AREAS, RETIRED_AREA_IDS, patternSlots, BANDS, rotationSlots, demoOutages,
  };
});
