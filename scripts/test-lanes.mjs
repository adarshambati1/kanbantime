/**
 * Correctness test for timetable overlap lane assignment (PLAN.md §3).
 *
 *   npm run test:lanes
 *
 * Compiles src/lib/lanes.ts on the fly — same pattern as test-rank.mjs.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'lanes-'));
process.on('exit', () => rmSync(out, { recursive: true, force: true }));
execFileSync('npx', ['tsc', 'src/lib/lanes.ts', '--ignoreConfig', '--outDir', out,
  '--module', 'esnext', '--target', 'es2022'], { stdio: 'inherit' });
const { assignLanes } = await import(pathToFileURL(join(out, 'lanes.js')).href);

let fails = 0;
const check = (cond, msg) => { if (!cond) { console.log('  FAIL', msg); fails++; } };
const laneOf = (result, id) => result.find((r) => r.id === id);

// No overlaps at all — every card gets its own lane 0, component size 1.
{
  const iv = [{ id: 'a', start: 0, minutes: 30 }, { id: 'b', start: 60, minutes: 30 }];
  const r = assignLanes(iv);
  check(laneOf(r, 'a').lane === 0 && laneOf(r, 'a').lanes === 1, 'isolated a: lane 0 of 1');
  check(laneOf(r, 'b').lane === 0 && laneOf(r, 'b').lanes === 1, 'isolated b: lane 0 of 1');
  console.log('  ok    no overlap -> each card alone in its own lane');
}

// Two cards overlapping — two lanes, same component.
{
  const iv = [{ id: 'a', start: 0, minutes: 30 }, { id: 'b', start: 15, minutes: 30 }];
  const r = assignLanes(iv);
  check(laneOf(r, 'a').lanes === 2 && laneOf(r, 'b').lanes === 2, 'two overlapping cards need 2 lanes');
  check(laneOf(r, 'a').lane !== laneOf(r, 'b').lane, 'overlapping cards get different lanes');
  console.log('  ok    two overlapping cards get 2 distinct lanes');
}

// Half-open interval: a card ending exactly when another starts does NOT
// count as overlapping, and may reuse the same lane.
{
  const iv = [{ id: 'a', start: 0, minutes: 30 }, { id: 'b', start: 30, minutes: 30 }];
  const r = assignLanes(iv);
  check(laneOf(r, 'a').lane === 0 && laneOf(r, 'b').lane === 0, 'touching endpoints reuse lane 0');
  check(laneOf(r, 'a').lanes === 1 && laneOf(r, 'b').lanes === 1, 'touching endpoints: 1 lane each, not merged');
  console.log('  ok    touching (non-overlapping) endpoints reuse the same lane');
}

// Transitive chain: A-B overlap, B-C overlap, C-D overlap, but A/C and B/D
// don't overlap each other. The whole chain is one component; 2 lanes
// suffice, with C reusing A's lane and D reusing B's.
{
  const iv = [
    { id: 'a', start: 0, minutes: 30 },  // 0-30
    { id: 'b', start: 15, minutes: 30 }, // 15-45
    { id: 'c', start: 30, minutes: 30 }, // 30-60 (touches a, overlaps b)
    { id: 'd', start: 45, minutes: 30 }, // 45-75 (touches b, overlaps c)
  ];
  const r = assignLanes(iv);
  check(iv.every((x) => laneOf(r, x.id).lanes === 2), 'transitive chain needs exactly 2 lanes');
  check(laneOf(r, 'a').lane === laneOf(r, 'c').lane, 'c reuses a\'s lane once a has ended');
  check(laneOf(r, 'b').lane === laneOf(r, 'd').lane, 'd reuses b\'s lane once b has ended');
  check(laneOf(r, 'a').lane !== laneOf(r, 'b').lane, 'a and b (concurrently open) differ');
  console.log('  ok    transitive A-B-C-D chain: 2 lanes, c/d correctly reuse a/b');
}

// Three cards all starting at once — three lanes, one component.
{
  const iv = [
    { id: 'a', start: 0, minutes: 60 },
    { id: 'b', start: 0, minutes: 60 },
    { id: 'c', start: 0, minutes: 60 },
  ];
  const r = assignLanes(iv);
  const lanesUsed = new Set(iv.map((x) => laneOf(r, x.id).lane));
  check(lanesUsed.size === 3, 'three simultaneous cards use three distinct lanes');
  check(iv.every((x) => laneOf(r, x.id).lanes === 3), 'component reports 3 lanes for all three');
  console.log('  ok    three simultaneous cards get three distinct lanes');
}

// Two separate overlap clusters on the same day don't interfere with
// each other's lane counts.
{
  const iv = [
    { id: 'a', start: 0, minutes: 30 },
    { id: 'b', start: 15, minutes: 30 },
    { id: 'c', start: 15, minutes: 30 },
    { id: 'z', start: 600, minutes: 30 },
  ];
  const r = assignLanes(iv);
  check(laneOf(r, 'z').lanes === 1, 'a far-away isolated card is unaffected by an earlier cluster');
  check(new Set(['a', 'b', 'c'].map((id) => laneOf(r, id).lane)).size === 3, 'the 3-way cluster still gets 3 lanes');
  console.log('  ok    independent clusters don\'t inflate each other\'s lane counts');
}

console.log(fails === 0 ? '\nlanes: all checks passed' : `\nlanes: ${fails} failed`);
process.exit(fails ? 1 : 0);
