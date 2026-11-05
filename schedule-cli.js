// Turns ZESCO's weekly load-management grid (written as a pattern file) into the CSV that /admin imports.
// Usage: npm run schedule -- <pattern.json> --from 2026-11-09 --days 28 [--town Lusaka] [--out schedule.csv]
// Pattern format: see schedules/zesco-2024-03.json and patternSlots() in public/core.js.
'use strict';
const fs = require('node:fs');
const core = require('./public/core.js');

function parseArgs(argv) {
  const opts = { file: null, from: core.lusakaDate(Date.now()), days: 28, town: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i];
    else if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--town') opts.town = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (!a.startsWith('--') && !opts.file) opts.file = a;
    else throw new Error(`Unknown option "${a}"`);
  }
  if (!opts.file) throw new Error('Give a pattern file, e.g. npm run schedule -- schedules/my-schedule.json --from 2026-11-09');
  if (!core.isValidDate(opts.from)) throw new Error('--from must be a date like 2026-11-09');
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 366) throw new Error('--days must be 1 to 366');
  return opts;
}

/** Returns {csv, count, source, errors}. */
function build(pattern, { from, days, town }) {
  const to = core.addDays(from, days - 1);
  const towns = pattern && pattern.towns && typeof pattern.towns === 'object' ? pattern.towns : null;
  if (!towns) return { errors: ['The pattern file needs a "towns" object'] };
  const names = town ? [town] : Object.keys(towns);
  const errors = [];
  const slots = [];
  for (const t of names) {
    if (!towns[t]) { errors.push(`Town "${t}" is not in the pattern file`); continue; }
    const r = core.patternSlots(t, towns[t], from, to);
    errors.push(...r.errors);
    slots.push(...r.slots);
  }
  if (errors.length) return { errors };
  const csv = ['group,date,start,end', ...slots.map((s) => `${s.group_code},${s.date},${s.start},${s.end}`)].join('\n') + '\n';
  return { csv, count: slots.length, source: pattern.source || null, errors: [] };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const pattern = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    const r = build(pattern, opts);
    if (r.errors.length) {
      console.error(`Nothing written. Fix these in ${opts.file}:\n- ${r.errors.join('\n- ')}`);
      process.exit(1);
    }
    if (r.source) console.error(`Source: ${r.source}`);
    if (opts.out) {
      fs.writeFileSync(opts.out, r.csv);
      console.error(`Wrote ${r.count} slots to ${opts.out}. Paste it into /admin -> Import schedule.`);
    } else process.stdout.write(r.csv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { build, parseArgs };
