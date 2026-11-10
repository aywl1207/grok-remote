// Parent status while the turn is blocked on children and no local tool is open.

export function countWaitingSubagents(statuses: Array<string | null | undefined>): number {
  let n = 0;
  for (const raw of statuses) {
    const st = String(raw || '').trim().toLowerCase();
    if (!st || st === 'pending' || st === 'running' || st === 'in_progress' || st === 'inprogress') n += 1;
  }
  return n;
}

export function waitingSubagentLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) return 'Waiting for 1 subagent…';
  return `Waiting for ${Math.floor(count)} subagents…`;
}
