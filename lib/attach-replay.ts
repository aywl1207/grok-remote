// Resume (`-r`) restreams the whole session before session_ready.
// Thought and message chunks carry _meta.isReplay. The tool_call rows in
// that burst do not. A burst can span more than one second, and some
// seconds have no session_ready. Drop replay lines, and drop tool rows
// that share a timestamp second with isReplay. Statusful tools from a
// normal turn do not share that second and stay.

export function eventIsReplay(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const meta = (data as { _meta?: { isReplay?: boolean } })._meta;
  return !!(meta && meta.isReplay === true);
}

/** True while grok is still restreaming, or when the row itself is replay. */
export function shouldDropResumeRestream(opts: {
  awaitingReady: boolean;
  isReplay: boolean;
}): boolean {
  return opts.isReplay || opts.awaitingReady;
}

const AT_MARK = '"at":"';
const EVENT_MARK = '"event":"';
const REPLAY_MARK = '"isReplay":true';

function atSecond(line: string): string {
  const i = line.indexOf(AT_MARK);
  if (i < 0) return '';
  return line.slice(i + AT_MARK.length, i + AT_MARK.length + 19);
}

function eventName(line: string): string {
  const i = line.indexOf(EVENT_MARK);
  if (i < 0) return '';
  const start = i + EVENT_MARK.length;
  const end = line.indexOf('"', start);
  if (end < 0) return '';
  return line.slice(start, end);
}

export function dropResumeRestreamLines(lines: string[]): string[] {
  const replaySeconds = new Set<string>();
  for (const line of lines) {
    if (line.indexOf(REPLAY_MARK) === -1) continue;
    const sec = atSecond(line);
    if (sec.length === 19) replaySeconds.add(sec);
  }
  if (replaySeconds.size === 0) return lines;
  const out: string[] = [];
  for (const line of lines) {
    if (line.indexOf(REPLAY_MARK) !== -1) continue;
    const ev = eventName(line);
    if ((ev === 'tool_call' || ev === 'tool_call_update') && replaySeconds.has(atSecond(line))) continue;
    out.push(line);
  }
  return out;
}
