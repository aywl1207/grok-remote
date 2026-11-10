import test from 'node:test';
import assert from 'node:assert/strict';
import { fillMissingToolStatus } from '../lib/history.js';

test('fillMissingToolStatus copies completed onto a later snapshot with no status', () => {
  const events = [
    { event: 'tool_call', data: { update: { toolCallId: 't1', status: 'completed', title: 'Execute ls' } } },
    { event: 'tool_call_update', data: { update: { toolCallId: 't1', title: 'Execute ls' } } },
  ];
  fillMissingToolStatus(events);
  const last = events[1]!.data as { update: { status?: string } };
  assert.equal(last.update.status, 'completed');
});

test('fillMissingToolStatus leaves a still-open tool alone', () => {
  const events = [
    { event: 'tool_call', data: { update: { toolCallId: 't2', title: 'Execute' } } },
  ];
  fillMissingToolStatus(events);
  const last = events[0]!.data as { update: { status?: string } };
  assert.equal(last.update.status, undefined);
});
