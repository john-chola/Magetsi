const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../public/core.js');
const { build, parseArgs } = require('../schedule-cli.js');

const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schedules', 'zesco-2024-03.json'), 'utf8'));

test('the example pattern file builds CSV that the admin import accepts', () => {
  const r = build(example, { from: '2024-03-11', days: 7 });
  assert.deepEqual(r.errors, []);
  const parsed = C.parseScheduleCsv(r.csv, C.GROUPS.map((g) => g.code));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.slots.length, r.count);
  // Lusaka 5 bands + Kitwe 3 + Ndola 4 + Livingstone 3, for 7 days
  assert.equal(r.count, (5 + 3 + 4 + 3) * 7);
  assert.ok(r.csv.startsWith('group,date,start,end\n'));
  assert.ok(r.csv.includes('KIT-C,2024-03-11,22:00,06:00'));
  assert.ok(r.csv.includes('NDL-D,2024-03-11,17:00,24:00'));
});

test('one town only, and clear errors', () => {
  const r = build(example, { from: '2024-03-18', days: 1, town: 'Kitwe' });
  assert.equal(r.csv, 'group,date,start,end\nKIT-B,2024-03-18,06:00,14:00\nKIT-A,2024-03-18,14:00,22:00\nKIT-C,2024-03-18,22:00,06:00\n');
  assert.match(build(example, { from: '2024-03-18', days: 1, town: 'Kabwe' }).errors[0], /not in the pattern file/);
  assert.match(build({}, { from: '2024-03-18', days: 1 }).errors[0], /towns/);
});

test('arguments', () => {
  assert.deepEqual(parseArgs(['p.json', '--from', '2026-11-09', '--days', '14', '--out', 'x.csv']),
    { file: 'p.json', from: '2026-11-09', days: 14, town: null, out: 'x.csv' });
  assert.throws(() => parseArgs([]), /pattern file/);
  assert.throws(() => parseArgs(['p.json', '--from', '9/11/2026']), /--from/);
  assert.throws(() => parseArgs(['p.json', '--bogus']), /Unknown option/);
});
