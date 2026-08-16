/**
 * Property test for fractional ranking: whatever the insertion pattern, the
 * result must always sort strictly where it was asked to go.
 *
 *   npm run test:rank
 *
 * Compiles src/lib/rank.ts on the fly — there's no test runner here and adding
 * one for a single file isn't worth it.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'rank-'));
process.on('exit', () => rmSync(out, { recursive: true, force: true }));
execFileSync('npx', ['tsc', 'src/lib/rank.ts', '--ignoreConfig', '--outDir', out,
  '--module', 'esnext', '--target', 'es2022'], { stdio: 'inherit' });
const { rankBetween, initialRanks } = await import(pathToFileURL(join(out, 'rank.js')).href);

let fails = 0;
const check = (cond, msg) => { if (!cond) { console.log('  FAIL', msg); fails++; } };

// Append repeatedly — ranks must strictly increase.
let prev = null;
const appended = [];
for (let i = 0; i < 500; i++) {
  const r = rankBetween(prev, null);
  check(prev === null || r > prev, `append ${i}: ${prev} -> ${r}`);
  appended.push(r);
  prev = r;
}
console.log(`  ok    500 appends strictly increasing (last "${prev}")`);

// Repeatedly insert into the same gap — the hardest case for this scheme.
let lo = appended[0], hi = appended[1];
for (let i = 0; i < 300; i++) {
  const mid = rankBetween(lo, hi);
  check(mid > lo && mid < hi, `insert ${i}: ${lo} < ${mid} < ${hi}`);
  hi = mid;
}
console.log(`  ok    300 inserts into one gap (final "${hi}", ${hi.length} chars)`);

// Prepending to the front.
let front = appended[0];
for (let i = 0; i < 200; i++) {
  const r = rankBetween(null, front);
  check(r < front, `prepend ${i}: ${r} < ${front}`);
  front = r;
}
console.log(`  ok    200 prepends strictly decreasing (final "${front}")`);

// Seeded columns come out ordered.
const seeded = initialRanks(50);
check(seeded.every((r, i) => i === 0 || r > seeded[i - 1]), 'initialRanks ordered');
console.log('  ok    initialRanks ordered');

// Rejects an inverted range rather than silently producing nonsense.
let threw = false;
try { rankBetween('z', 'a'); } catch { threw = true; }
check(threw, 'inverted range should throw');
console.log('  ok    inverted range rejected');

console.log(fails === 0 ? '\nrank: all checks passed' : `\nrank: ${fails} failed`);
process.exit(fails ? 1 : 0);
