// GET /api/agents/:id/history
//
// Journal is the spine. This handler never writes history.jsonl — a
// compact-during-GET race already dropped newest turns. Compact only
// the in-memory slice (see history.ts compactHistoryForHttp).

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  readAll,
  readLastUserTurns,
  readUserTurnsWindow,
  countUserTurns,
  sliceHistoryByTurns,
  historyWantsAll,
} from './history.js';
import { mergeSessionTranscript } from './transcript.js';
import { listSubagentSessionIds } from './tui-sessions.js';

export interface HistoryAgentRec {
  cwd?: string;
  sessionId?: string;
  lastSessionId?: string;
}

export function handleHistoryGet(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  rec: HistoryAgentRec | null,
): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const allReq = urlObj.searchParams.get('all') === '1';
  const turnsParam = parseInt(urlObj.searchParams.get('turns') || '50', 10);
  const turns = Number.isFinite(turnsParam) && turnsParam > 0 ? turnsParam : 50;
  const skipParam = parseInt(urlObj.searchParams.get('skip') || '0', 10);
  const skip = Number.isFinite(skipParam) && skipParam > 0 ? skipParam : 0;
  const journalTurns = countUserTurns(id);
  // Older windows: exactly `turns` before the already-painted tail.
  // Never compact-merge or read the whole journal for this.
  if (skip > 0) {
    const raw = readUserTurnsWindow(id, turns, skip);
    const dropSessionIds = listSubagentSessionIds();
    const sliced = sliceHistoryByTurns(raw, { all: true, turns, dropSessionIds });
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Total-Turns': String(journalTurns),
      'X-Returned-Turns': String(sliced.returnedTurns),
      'X-Last-Event-Id': sliced.lastEventId || '',
    });
    res.end(sliced.text);
    return;
  }
  // Small conversations: send every turn. Huge journals must tail-read
  // or first paint waits on tens of megabytes.
  const wantAll = historyWantsAll(allReq, journalTurns, turns);
  const raw = wantAll ? (readAll(id) || '') : readLastUserTurns(id, turns);
  // Always merge the TUI tail. After a grok-remote restart the journal can
  // miss the newest user_message while Grok's chat_history.jsonl has it.
  const merged = mergeSessionTranscript(raw, rec, {
    journalTurnCount: journalTurns,
    skipCompaction: !wantAll,
  });
  const dropSessionIds = listSubagentSessionIds();
  const sliced = sliceHistoryByTurns(merged, { all: wantAll, turns, dropSessionIds });
  const totalTurns = Math.max(journalTurns, sliced.totalTurns);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Total-Turns': String(totalTurns),
    'X-Returned-Turns': String(sliced.returnedTurns),
    'X-Last-Event-Id': sliced.lastEventId || '',
  });
  res.end(sliced.text);
}
