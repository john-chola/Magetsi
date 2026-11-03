// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/core.js');

const at = (date, time) => C.toMs(date, time);

test('slot past midnight ends the next day', () => {
  const w = C.slotWindow({ date: '2026-11-01', start: '22:00', end: '02:00' });
  assert.equal(w.endMs - w.startMs, 4 * C.HOUR);
  assert.equal(C.lusakaDate(w.endMs), '2026-11-02');
});

test('touching slots merge into one window', () => {
  const ws = C.mergedWindows([
    { date: '2026-11-01', start: '06:00', end: '10:00' },
    { date: '2026-11-01', start: '10:00', end: '14:00' },
    { date: '2026-11-01', start: '18:00', end: '22:00' },
  ]);
  assert.equal(ws.length, 2);
  assert.equal(ws[0].endMs - ws[0].startMs, 8 * C.HOUR);
});

test('schedule state: off now, then next change is restore', () => {
  const slots = [{ date: '2026-11-01', start: '06:00', end: '10:00' }, { date: '2026-11-01', start: '18:00', end: '22:00' }];
  const s1 = C.scheduleState(slots, at('2026-11-01', '07:30'));
  assert.equal(s1.scheduledOff, true);
  assert.equal(C.lusakaTime(s1.nextChangeMs), '10:00');
  const s2 = C.scheduleState(slots, at('2026-11-01', '12:00'));
  assert.equal(s2.scheduledOff, false);
  assert.equal(C.lusakaTime(s2.nextChangeMs), '18:00');
});

test('community reports override schedule and flag unscheduled outages', () => {
  const slots = [{ date: '2026-11-01', start: '06:00', end: '10:00' }];
  const now = at('2026-11-01', '13:00');
  const outages = [
    { device_id: 'a', offMs: now - 10 * C.MIN, onMs: null },
    { device_id: 'b', offMs: now - 5 * C.MIN, onMs: null },
  ];
  const st = C.computeStatus({ slots, outages, now, deviceId: 'a' });
  assert.equal(st.likely, 'off');
  assert.equal(st.community.unscheduled, true);
  assert.ok(st.myOpenOutage);
});

test('adherence: on time, late restore and extra outage', () => {
  const slots = [{ date: '2026-11-01', start: '06:00', end: '10:00' }];
  const fromMs = at('2026-11-01', '00:00'), toMs = at('2026-11-02', '00:00');
  const mk = (id, off, on) => ({ device_id: id, offMs: at('2026-11-01', off), onMs: at('2026-11-01', on) });
  const outages = [
    mk('h1', '06:00', '10:00'),                     // perfect
    mk('h2', '06:00', '11:00'),                     // 60 min late
    mk('h3', '06:00', '11:00'), mk('h3', '15:00', '16:00'), // late + 1 h unscheduled
  ];
  const s = C.adherence({ slots, outages, fromMs, toMs });
  assert.equal(s.households, 3);
  assert.equal(s.enough, true);
  assert.equal(s.scheduledHoursPerDay, 4);
  assert.equal(s.lateRestoreMinPerDay, 60);       // median of 0, 60, 60
  assert.equal(s.extraHoursPerDay, 1);            // median of 0, 1, 2 hours outside slots
  assert.equal(s.onSchedulePct, 80);              // median of 100, 80, 67
});

test('adherence hides figures with fewer than 3 households', () => {
  const s = C.adherence({ slots: [], outages: [{ device_id: 'x', offMs: 0, onMs: C.HOUR }], fromMs: 0, toMs: C.DAY });
  assert.equal(s.enough, false);
  assert.equal(s.onSchedulePct, null);
});

test('flagged outages are ignored', () => {
  const s = C.adherence({ slots: [], outages: [{ device_id: 'x', offMs: 0, onMs: C.HOUR, flagged: 1 }], fromMs: 0, toMs: C.DAY });
  assert.equal(s.households, 0);
});

test('manual outage validation', () => {
  const now = at('2026-11-05', '12:00');
  assert.equal(C.validateManualOutage(now - 2 * C.HOUR, now - C.HOUR, now), null);
  assert.match(C.validateManualOutage(now - C.HOUR, now - 2 * C.HOUR, now), /after/);
  assert.match(C.validateManualOutage(now - 30 * C.HOUR, now - C.HOUR, now), /24 hours/);
  assert.match(C.validateManualOutage(now - 9 * C.DAY, now - 9 * C.DAY + C.HOUR, now), /7 days/);
});

test('CSV parser accepts header and rejects bad rows', () => {
  const ok = C.parseScheduleCsv('group,date,start,end\nb,2026-11-02,06:00,10:00\n', ['A', 'B']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.slots[0].group_code, 'B');
  const bad = C.parseScheduleCsv('Z,2026-11-02,06:00,10:00\nB,02/11/2026,06:00,10:00', ['A', 'B']);
  assert.equal(bad.errors.length, 2);
});

test('demo rotation gives every group 8 hours a day', () => {
  const slots = C.rotationSlots('2026-11-01', 1);
  for (const g of C.GROUPS) {
    const ws = C.mergedWindows(slots.filter((s) => s.group_code === g.code));
    const total = ws.reduce((t, w) => t + w.endMs - w.startMs, 0);
    assert.equal(total, 8 * C.HOUR);
  }
});

// ---------- alerts, SMS, towns ----------
test('push alerts: reminder before off, restore, quiet hours, unscheduled', () => {
  const area = { id: 7, name: 'Chilenje' };
  const slots = [{ date: '2026-11-01', start: '18:00', end: '22:00' }];
  const tags = (now, settings, status) => C.dueAlerts({ area, slots, status, settings, now }).map((a) => a.tag.split('-')[0]);
  assert.deepEqual(tags(at('2026-11-01', '17:40'), { leadMin: 30 }), ['off']);
  assert.deepEqual(tags(at('2026-11-01', '17:40'), { leadMin: 10 }), []);
  assert.deepEqual(tags(at('2026-11-01', '21:55'), {}), ['on']);
  assert.deepEqual(tags(at('2026-11-01', '21:55'), { restore: false }), []);
  const late = [{ date: '2026-11-01', start: '23:30', end: '02:00' }];
  assert.equal(C.dueAlerts({ area, slots: late, settings: {}, now: at('2026-11-01', '23:10') }).length, 0);
  assert.equal(C.dueAlerts({ area, slots: late, settings: { quiet: false }, now: at('2026-11-01', '23:10') }).length, 1);
  const status = { community: { unscheduled: true, offNow: 3 } };
  assert.deepEqual(tags(at('2026-11-01', '12:00'), {}, status), ['unsched']);
  assert.deepEqual(tags(at('2026-11-01', '12:00'), { community: false }, status), []);
});

test('alert text uses Lusaka times', () => {
  const [a] = C.dueAlerts({ area: { id: 1, name: 'Avondale' }, slots: [{ date: '2026-11-01', start: '18:00', end: '22:00' }], settings: {}, now: at('2026-11-01', '17:45') });
  assert.equal(a.title, 'Power off at 18:00 in Avondale');
  assert.match(a.body, /until 22:00\. About 15 minutes/);
});

test('settings are cleaned', () => {
  assert.deepEqual(C.cleanSettings({ leadMin: 999, restore: 'yes', quiet: false }), { leadMin: 30, restore: true, community: true, quiet: false });
});

test('SMS: morning summary once a day window, reminder before outages, none at night', () => {
  const area = { id: 7, name: 'Chilenje' };
  const slots = [{ date: '2026-11-01', start: '06:00', end: '10:00' }, { date: '2026-11-01', start: '22:00', end: '02:00' }];
  const due = (now, sub) => C.smsDue({ area, slots, sub, now });
  const morning = due(at('2026-11-01', '05:40'), { daily: 1, before_min: 30 });
  assert.equal(morning.length, 2);
  assert.equal(morning[0].text, 'Magetsi: Chilenje power off today 06:00-10:00, 22:00-02:00. Reply STOP to end.');
  assert.match(morning[1].text, /at 06:00, back 10:00/);
  assert.ok(morning.every((m) => m.text.length <= 160));
  assert.equal(due(at('2026-11-01', '08:00'), { daily: 1, before_min: 0 }).length, 0);
  assert.equal(due(at('2026-11-01', '21:40'), { daily: 0, before_min: 30 }).length, 1);
  const night = [{ date: '2026-11-01', start: '02:00', end: '06:00' }];
  assert.equal(C.smsDue({ area, slots: night, sub: { daily: 0, before_min: 60 }, now: at('2026-11-01', '01:30') }).length, 0);
});

test('Zambian phone numbers', () => {
  assert.equal(C.normalizePhone('097 123 4567'), '+260971234567');
  assert.equal(C.normalizePhone('+260 76-123-4567'), '+260761234567');
  assert.equal(C.normalizePhone('260955123456'), '+260955123456');
  assert.equal(C.normalizePhone('0211 123456'), null);
  assert.equal(C.normalizePhone('+27821234567'), null);
});

test('SMS commands', () => {
  const p = (t) => C.parseSmsCommand(t, C.AREAS);
  assert.equal(p('JOIN Chilenje').area.name, 'Chilenje');
  assert.equal(p('magetsi chilenje').area.name, 'Chilenje');
  assert.equal(p('join mutendere east').area.name, 'Mutendere East');
  assert.equal(p('Mtendere').area.name, 'Mtendere');
  assert.equal(p('JOIN KAB').cmd, 'ambiguous');
  assert.equal(p('JOIN Atlantis').cmd, 'unknown');
  assert.equal(p('stop').cmd, 'stop');
  assert.equal(p('Times').cmd, 'times');
  assert.equal(p('').cmd, 'help');
  assert.equal(p('JOIN 7').area.name, 'Chilenje');
});

test('areas: Lusaka ids unchanged, towns added, names unique', () => {
  assert.deepEqual(C.AREAS.slice(0, 3).map((a) => [a.id, a.name, a.town]), [[1, 'Avondale', 'Lusaka'], [2, 'Bauleni', 'Lusaka'], [3, 'Chainda', 'Lusaka']]);
  assert.equal(C.AREAS.find((a) => a.id === 30).name, 'PHI');
  assert.ok(C.TOWNS.length >= 5);
  assert.equal(new Set(C.AREAS.map((a) => a.name.toLowerCase())).size, C.AREAS.length);
});

test('dashboard CSV quotes cells and leaves thin data blank', () => {
  const csv = C.dashboardCsv([{ id: 1, name: 'Area, "North"', town: 'Lusaka', group_code: 'A', households: 1, enough: false, onSchedulePct: null }], { from: '2026-11-01', to: '2026-11-08' });
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^# /);
  assert.equal(lines[1].split(',')[0], 'area_id');
  assert.equal(lines[2], '1,"Area, ""North""",Lusaka,A,1,0,,,,,');
});
