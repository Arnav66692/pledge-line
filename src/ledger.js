import fs from 'node:fs';
import path from 'node:path';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function loadLines(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const events = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A torn last line from a crash is skipped rather than failing the whole load.
    }
  }
  return events;
}

/**
 * Append-only JSONL event log. Every event gets an ISO `ts` and a global `seq`.
 * Existing lines are loaded on start so pilot-check can read what the server wrote.
 */
export function createLedger({ path: file, now = () => new Date() }) {
  if (typeof file !== 'string' || file === '') throw new Error('createLedger needs a path');
  const events = [];
  const byCallId = new Map();
  const byTypeName = new Map();
  let seq = 0;
  let dirReady = false;
  let boundaryChecked = false;

  function index(event) {
    events.push(event);
    if (event.callId) {
      if (!byCallId.has(event.callId)) byCallId.set(event.callId, []);
      byCallId.get(event.callId).push(event);
    }
    if (!byTypeName.has(event.type)) byTypeName.set(event.type, []);
    byTypeName.get(event.type).push(event);
    if (Number.isInteger(event.seq) && event.seq > seq) seq = event.seq;
  }

  for (const event of loadLines(file)) index(deepFreeze(event));

  function append(event, { durable = false } = {}) {
    if (!event || typeof event.type !== 'string') throw new Error('ledger events need a type');
    const full = deepFreeze(structuredClone({ ...event, ts: now().toISOString(), seq: seq + 1 }));
    if (!dirReady) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      dirReady = true;
    }
    if (!boundaryChecked) {
      // A crash can leave a torn final line. Separate the next complete event from that fragment so it remains
      // readable after a later restart. loadLines deliberately skips the fragment, and does not rewrite history.
      const fd = fs.openSync(file, 'a+');
      try {
        const size = fs.fstatSync(fd).size;
        if (size > 0) {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 10) fs.writeSync(fd, '\n');
        }
      } finally {
        fs.closeSync(fd);
      }
      boundaryChecked = true;
    }
    const line = `${JSON.stringify(full)}\n`;
    try {
      if (durable) {
        const fd = fs.openSync(file, 'a');
        try {
          fs.writeFileSync(fd, line);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        fs.appendFileSync(file, line);
      }
    } catch (error) {
      // The failed write may have left a partial line in this same process. Check its boundary on retry too.
      boundaryChecked = false;
      throw error;
    }
    index(full);
    return full;
  }

  return {
    append,
    byCall: (callId) => (byCallId.get(callId) ?? []).slice(),
    byType: (type) => (byTypeName.get(type) ?? []).slice(),
    all: () => events.slice(),
    since: (isoTime) => events.filter((event) => event.ts >= isoTime),
    path: file,
  };
}
