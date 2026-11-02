import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHoursLog, parseLogDate, parseLogTime, ptToUtcMs, sixthHourEnd, effectiveDeadline, loggedHours, inWindow, outsideWindow, inLoggedRow } from '../src/hours-log.js';

const DEADLINE = '2026-11-05T05:00:00.000Z';

/** The Hours log section the way PILOT.md lays it out, with the given rows. */
const pilotMd = (...rows) => ['# Pledge Line pilot', '', '## Hours log', '', 'These hours come out of PowerGate.', '',
  '| Date | Start | End | Hours | What |', '|---|---|---|---|---|', ...rows, '', '**Running total:** 0 of 6.', '', '## Change log', '', '- Nov 1, 2026.'].join('\n');

test('dates and times are read in the common forms, in PT', () => {
  for (const date of ['Tue Nov 3', 'Nov 3', '11/3', 'Tuesday, November 3, 2026', 'nov. 3', '11/03/2026', '2026-11-03', 'Tue 11/3']) {
    assert.equal(parseLogDate(date)?.iso, '2026-11-03', date);
  }
  for (const date of ['Wed Nov 3', 'Nov 33', '13/3', 'Nov 3, 2025', 'Nob 3', '', 'yesterday']) assert.equal(parseLogDate(date), null, date);
  const times = [['6:00 pm', 1080], ['6 pm', 1080], ['6pm', 1080], ['18:00', 1080], ['6:30 p.m.', 1110], ['noon', 720], ['12 am', 0], ['9:15 AM', 555], ['6:00 pm PT', 1080]];
  for (const [text, minutes] of times) assert.equal(parseLogTime(text), minutes, text);
  for (const text of ['6', '25:00', '6:75 pm', '13 pm', 'evening', '']) assert.equal(parseLogTime(text), null, text);
  assert.equal(new Date(ptToUtcMs(10, 3, 18 * 60)).toISOString(), '2026-11-04T02:00:00.000Z', '6 pm PT on Nov 3 is 2 am UTC on Nov 4');
  assert.equal(new Date(ptToUtcMs(9, 31, 18 * 60)).toISOString(), '2026-11-01T01:00:00.000Z', 'before the clocks went back, PT is seven hours behind');
});

test('the Hours log skips blank rows, counts Start to End, and names any row it cannot read', () => {
  const ok = parseHoursLog(pilotMd('| Tue Nov 3 | 6:00 pm | 8:30 pm | 2.5 | sandbox setup |', '| | | | | |', '| Wed Nov 4 | 6 pm | 21:00 | 2 | calls |'));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.rows.length, 2);
  assert.equal(loggedHours(ok.rows), 5.5, 'Start and End decide the hours, not the Hours column');
  assert.deepEqual(parseHoursLog(pilotMd('| | | | | |')), { rows: [], problems: [] });
  const bad = parseHoursLog(pilotMd('| Tue Nov 3 | 6:00 pm | 8:30 pm | 2.5 | ok |', '| Wed Nov 3 | 6 pm | 7 pm | 1 | typo |',
    '| Wed Nov 4 | 8 pm | 7 pm | 1 | backwards |', '| Wed Nov 4 | 6 | 7 pm | 1 | no am or pm |'));
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems[0], /^Line 10 of PILOT\.md, `\| Wed Nov 3 \| 6 pm \| 7 pm \| 1 \| typo \|`, has a Date pilot-check cannot read$/);
  assert.match(bad.problems[1], /End that is not after its Start/);
  assert.match(bad.problems[2], /Start pilot-check cannot read/);
  assert.match(parseHoursLog('# No log here').problems[0], /no "## Hours log" section/);
  assert.deepEqual(outsideWindow(parseHoursLog(pilotMd('| 11/2 | 9 am | 10 am | 1 | early |')).rows).map((r) => r.day), ['2026-11-02']);
});

test('the 6th logged hour ends inside the row that reaches it, overlaps count once, and the earlier deadline wins', () => {
  const { rows } = parseHoursLog(pilotMd('| Tue Nov 3 | 6:00 pm | 9:00 pm | 3 | a |', '| Tue Nov 3 | 8:00 pm | 9:00 pm | 1 | logged twice |',
    '| Wed Nov 4 | 5:00 pm | 7:00 pm | 2 | b |', '| Wed Nov 4 | 7:30 pm | 8:30 pm | 1 | c |'));
  assert.equal(loggedHours(rows), 6);
  assert.equal(new Date(sixthHourEnd(rows)).toISOString(), '2026-11-05T04:30:00.000Z', '8:30 pm PT on Wed Nov 4');
  assert.deepEqual(effectiveDeadline(rows, DEADLINE), { iso: '2026-11-05T04:30:00.000Z', bySixthHour: true, sixthHourEnd: '2026-11-05T04:30:00.000Z' });
  const short = parseHoursLog(pilotMd('| Wed Nov 4 | 5:00 pm | 7:00 pm | 2 | b |')).rows;
  assert.equal(sixthHourEnd(short), null);
  assert.deepEqual(effectiveDeadline(short, DEADLINE), { iso: DEADLINE, bySixthHour: false, sixthHourEnd: null });
});

test('a time with no am or pm is read only as a 24-hour time, so an evening 5:00 is refused, not read as morning (G3)', () => {
  for (const text of ['5:00', '8:30', '11:59', '1:00', '05:00']) assert.equal(parseLogTime(text), null, text);
  for (const [text, minutes] of [['12:30', 750], ['13:00', 780], ['0:30', 30], ['18:00', 1080], ['23:59', 1439], ['5:00 pm', 1020]]) assert.equal(parseLogTime(text), minutes, text);
  const { problems } = parseHoursLog(pilotMd('| Tue Nov 3 | 5:00 | 8:00 | 3 | sandbox setup |'));
  assert.match(problems[0], /Line 9 of PILOT\.md, `\| Tue Nov 3 \| 5:00 \| 8:00 \| 3 \| sandbox setup \|`, has a Start pilot-check cannot read/);
});

test('only rows on Tue Nov 3 and Wed Nov 4 count toward the 6 hours, so a Monday row never moves the deadline (G4)', () => {
  const { rows } = parseHoursLog(pilotMd('| Mon Nov 2 | 7:00 pm | 10:00 pm | 3 | read the code |', '| Tue Nov 3 | 5:00 pm | 8:00 pm | 3 | setup and calls |',
    '| Wed Nov 4 | 6:00 pm | 7:00 pm | 1 | Safari rerun |'));
  assert.equal(loggedHours(rows), 4);
  assert.equal(sixthHourEnd(rows), null);
  assert.deepEqual(effectiveDeadline(rows, DEADLINE), { iso: DEADLINE, bySixthHour: false, sixthHourEnd: null });
  assert.deepEqual(outsideWindow(rows).map((r) => r.day), ['2026-11-02']);
  assert.deepEqual(inWindow(rows).map((r) => r.day), ['2026-11-03', '2026-11-04']);
  assert.equal(inLoggedRow(rows[0].startMs + 60000, rows), false, 'a time in the Monday row is outside every counted row');
});
