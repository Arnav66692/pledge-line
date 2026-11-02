// Reads the Hours log table in PILOT.md, so pilot-check knows when the 6th logged hour ended (PILOT.md, the deadline).
// Times are PT. Start and End decide the hours, not the Hours column. Pure functions, so tests can grade a scratch copy.
const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const MINUTES_PER_HOUR = 60;
const NOON = 12;
const MIN_NAME_LETTERS = 3;
export const LOGGED_HOURS = 6;
const YEAR = 2026;
// The bar's window, Tue Nov 3 and Wed Nov 4. A row on another day never counts toward the 6 hours and is shown as a warning.
const WINDOW_DAYS = new Set(['2026-11-03', '2026-11-04']);
export const EXPECTED_ROW = '| Tue Nov 3 | 6:00 pm | 8:30 pm | 2.5 | sandbox setup |';
export const ACCEPTED_FORMS = 'Dates can be Tue Nov 3, Nov 3 or 11/3, and times 6:00 pm, 6 pm, 6pm or 18:00, all in PT. '
  + 'A time such as 6:00 with no am or pm could be morning or evening, so it needs one';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PT_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });

// "tue", "tues" and "tuesday" all name Tuesday. Three letters at least, so "m" or "ju" never guess.
const byPrefix = (names, word) => (word && word.length >= MIN_NAME_LETTERS ? names.findIndex((name) => name.startsWith(word)) : -1);

function realDate(monthIndex, day) {
  const date = new Date(Date.UTC(YEAR, monthIndex, day));
  return date.getUTCMonth() === monthIndex && date.getUTCDate() === day ? date : null;
}

function dateParts(text) {
  const named = text.match(/^(?:([a-z]+) )?([a-z]+) (\d{1,2})(?: (\d{4}))?$/);
  if (named) return { weekday: named[1], monthIndex: byPrefix(MONTHS, named[2]), day: Number(named[3]), year: named[4] };
  const slashed = text.match(/^(?:([a-z]+) )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (slashed) return { weekday: slashed[1], monthIndex: Number(slashed[2]) - 1, day: Number(slashed[3]), year: slashed[4] };
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return iso ? { monthIndex: Number(iso[2]) - 1, day: Number(iso[3]), year: iso[1] } : null;
}

/** "Tue Nov 3", "Nov 3", "November 3, 2026", "11/3" or "2026-11-03", year 2026. A weekday, when given, must match the date. */
export function parseLogDate(raw) {
  const parts = dateParts(String(raw ?? '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim());
  if (!parts) return null;
  const year = parts.year === undefined ? YEAR : Number(parts.year.length === 2 ? `20${parts.year}` : parts.year);
  const date = year === YEAR && parts.monthIndex >= 0 ? realDate(parts.monthIndex, parts.day) : null;
  if (!date || (parts.weekday !== undefined && byPrefix(WEEKDAYS, parts.weekday) !== date.getUTCDay())) return null;
  return { monthIndex: parts.monthIndex, day: parts.day, iso: date.toISOString().slice(0, 10) };
}

/**
 * Minutes after midnight for "6:00 pm", "6 pm", "6pm", "6:30 p.m.", "noon" or "18:00". A bare "6", or a "6:00" with
 * no am or pm, could be morning or evening, so it is unreadable and the grade is refused (G3). With no am or pm,
 * only 24-hour times, 0:00 to 0:59 and 12:00 to 23:59, are read.
 */
export function parseLogTime(raw) {
  const text = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\s*\b(?:pt|pst|pdt)$/, '').replace(/([ap])\.m\.?/, '$1m').trim();
  if (text === 'noon') return NOON * MINUTES_PER_HOUR;
  const m = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (minute >= MINUTES_PER_HOUR) return null;
  if (m[3]) return hour >= 1 && hour <= NOON ? ((hour % NOON) + (m[3] === 'pm' ? NOON : 0)) * MINUTES_PER_HOUR + minute : null;
  const twentyFourHour = hour === 0 || (hour >= NOON && hour < 24);
  return m[2] !== undefined && twentyFourHour ? hour * MINUTES_PER_HOUR + minute : null;
}

function offsetMs(ms) {
  const p = Object.fromEntries(PT_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return wall - (ms - (ms % MINUTE_MS));
}

/** The UTC time of a PT wall clock time in 2026, right on either side of a daylight saving change. */
export function ptToUtcMs(monthIndex, day, minutes) {
  const wall = Date.UTC(YEAR, monthIndex, day, 0, minutes);
  const guess = wall - offsetMs(wall);
  return wall - offsetMs(guess);
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
const isRule = (cells) => cells.every((cell) => /^:?-{3,}:?$/.test(cell));

function tableAfter(lines, heading) {
  const table = [];
  for (let i = heading + 1; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (/^#{1,6}\s/.test(text)) break;
    if (text.startsWith('|')) table.push({ line: i + 1, text });
    else if (table.length > 0) break;
  }
  return table;
}

function parseRow(cells, cols) {
  const date = parseLogDate(cells[cols.date]);
  if (!date) return { problem: 'has a Date pilot-check cannot read' };
  const start = parseLogTime(cells[cols.start]);
  if (start === null) return { problem: 'has a Start pilot-check cannot read' };
  const end = parseLogTime(cells[cols.end]);
  if (end === null) return { problem: 'has an End pilot-check cannot read' };
  if (!(end > start)) return { problem: 'has an End that is not after its Start, and a session past midnight goes in two rows' };
  return { row: { day: date.iso, startMs: ptToUtcMs(date.monthIndex, date.day, start), endMs: ptToUtcMs(date.monthIndex, date.day, end) } };
}

/**
 * The rows of the table under "## Hours log", blank rows skipped. Each problem names the line and the row it
 * could not read, so pilot-check refuses to grade instead of guessing (R3-11).
 */
export function parseHoursLog(markdown, file = 'PILOT.md') {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const heading = lines.findIndex((line) => /^#{2,6}\s+hours log\s*$/i.test(line.trim()));
  if (heading < 0) return { rows: [], problems: [`${file} has no "## Hours log" section`] };
  const table = tableAfter(lines, heading);
  if (table.length === 0) return { rows: [], problems: [`the Hours log in ${file} has no table`] };
  const header = cellsOf(table[0].text).map((cell) => cell.toLowerCase());
  const cols = { date: header.indexOf('date'), start: header.indexOf('start'), end: header.indexOf('end') };
  if (Object.values(cols).some((i) => i < 0)) return { rows: [], problems: [`the Hours log header on line ${table[0].line} of ${file} needs Date, Start and End columns`] };
  const rows = [];
  const problems = [];
  for (const { line, text } of table.slice(1)) {
    const cells = cellsOf(text);
    if (isRule(cells) || cells.every((cell) => cell === '')) continue;
    const parsed = parseRow(cells, cols);
    if (parsed.problem) problems.push(`Line ${line} of ${file}, \`${text}\`, ${parsed.problem}`);
    else rows.push({ ...parsed.row, line, text });
  }
  return { rows, problems };
}

/** The logged spans in time order, overlaps merged, so a session logged twice is not counted twice. */
export function loggedSpans(rows) {
  const sorted = rows.map((r) => [r.startMs, r.endMs]).sort((a, b) => a[0] - b[0]);
  return sorted.reduce((spans, [start, end]) => {
    const last = spans.at(-1);
    if (last && start <= last[1]) return [...spans.slice(0, -1), [last[0], Math.max(last[1], end)]];
    return [...spans, [start, end]];
  }, []);
}

/** The rows on Tue Nov 3 and Wed Nov 4, the only days the bar's window counts. */
export const inWindow = (rows) => rows.filter((r) => WINDOW_DAYS.has(r.day));
export const outsideWindow = (rows) => rows.filter((r) => !WINDOW_DAYS.has(r.day));

/** The hours logged on Tue Nov 3 and Wed Nov 4, overlaps counted once. A row on another day never counts (G4). */
export const loggedHours = (rows) => loggedSpans(inWindow(rows)).reduce((sum, [start, end]) => sum + end - start, 0) / HOUR_MS;
export const rowHours = (row) => (row.endMs - row.startMs) / HOUR_MS;

/** When the 6th hour logged on Tue Nov 3 and Wed Nov 4 ended, or null while fewer than 6 hours are logged there (G4). */
export function sixthHourEnd(rows) {
  let left = LOGGED_HOURS * HOUR_MS;
  for (const [start, end] of loggedSpans(inWindow(rows))) {
    if (end - start >= left) return start + left;
    left -= end - start;
  }
  return null;
}

/** The bar's deadline: 9:00 pm PT on Wed Nov 4 or the end of the 6th logged hour, whichever comes first. */
export function effectiveDeadline(rows, deadline) {
  const sixth = sixthHourEnd(rows);
  const bar = Date.parse(deadline);
  if (sixth !== null && sixth < bar) return { iso: new Date(sixth).toISOString(), bySixthHour: true, sixthHourEnd: new Date(sixth).toISOString() };
  return { iso: new Date(bar).toISOString(), bySixthHour: false, sixthHourEnd: sixth === null ? null : new Date(sixth).toISOString() };
}

/** True when the time falls inside a row logged on Tue Nov 3 or Wed Nov 4. */
export const inLoggedRow = (ms, rows) => inWindow(rows).some((r) => ms >= r.startMs && ms <= r.endMs);
