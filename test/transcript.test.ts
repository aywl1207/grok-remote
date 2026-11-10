import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractUserQuery,
  extractCompactionSummary,
  isSyntheticUserText,
  mergeEventLines,
  concatSessionEvents,
  appendNewerSessionTurns,
  sessionLinesToEvents,
  lastUserTurnHasAssistant,
} from '../lib/transcript.js';

function user(text: string): string {
  return JSON.stringify({ event: 'user_message', data: { text } });
}
function msg(text: string): string {
  return JSON.stringify({
    event: 'agent_message_chunk',
    data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
}

test('compacted session does not wipe a longer journal', () => {
  const journal = [
    user('左邊panel 有無可以優化的地方?'),
    msg('old reply'),
    user('好做埋oidc 駁住authentik得唔得?'),
    msg('oidc reply'),
    user('UI do not have the latest history'),
  ];
  const session = [
    user('conversation errored ERROR agent stdin not writable'),
    msg('fixing stdin'),
    user('UI do not have the latest history'),
    msg('looking at history'),
  ];
  const out = mergeEventLines(journal, session);
  const users = out.map((l) => {
    const o = JSON.parse(l) as { event?: string; data?: { text?: string } };
    return o.event === 'user_message' ? o.data!.text : null;
  }).filter(Boolean);
  assert.deepEqual(users, [
    '左邊panel 有無可以優化的地方?',
    '好做埋oidc 駁住authentik得唔得?',
    'conversation errored ERROR agent stdin not writable',
    'UI do not have the latest history',
  ]);
  assert.ok(out.includes(msg('old reply')));
  assert.ok(out.includes(msg('oidc reply')));
});

test('session-only tail turn is not appended when the journal already has users', () => {
  const journal = [user('first'), msg('a')];
  const session = [user('first'), msg('a'), user('from cli'), msg('b')];
  const out = mergeEventLines(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['first']);
});

test('no session keeps the journal', () => {
  const journal = [user('only journal'), msg('x')];
  assert.deepEqual(mergeEventLines(journal, []), journal);
});

test('no journal uses the session', () => {
  const session = [user('only session'), msg('x')];
  assert.deepEqual(mergeEventLines([], session), session);
});

test('identical users do not duplicate', () => {
  const journal = [user('same'), msg('journal reply')];
  const session = [user('same'), msg('session reply')];
  const out = mergeEventLines(journal, session);
  const users = out.filter((l) => l.includes('"user_message"'));
  assert.equal(users.length, 1);
  assert.ok(out.includes(msg('journal reply')));
  assert.equal(out.includes(msg('session reply')), false);
});

test('sessionLinesToEvents drops compaction / system wrappers', () => {
  const raw = [
    JSON.stringify({ type: 'user', content: '<user_info>os</user_info>' }),
    JSON.stringify({ type: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' }),
    JSON.stringify({ type: 'user', content: '<user_query>keep me</user_query>' }),
    JSON.stringify({ type: 'user', content: '<system-reminder>nope</system-reminder>', synthetic_reason: 'x' }),
    JSON.stringify({ type: 'assistant', content: 'hello' }),
  ].join('\n');
  const ev = sessionLinesToEvents(raw);
  const users = ev.map((l) => JSON.parse(l)).filter((o) => o.event === 'user_message');
  assert.equal(users.length, 1);
  assert.equal(users[0].data.text, 'keep me');
});

test('extractUserQuery and synthetic helpers', () => {
  assert.equal(extractUserQuery('<user_query>hi</user_query>'), 'hi');
  assert.equal(isSyntheticUserText('<user_info>x</user_info>'), true);
  assert.equal(isSyntheticUserText('real question'), false);
});


test('session-only middle turns keep chronological order', () => {
  const journal = [user('start'), msg('a'), user('reboot'), msg('b'), user('disk'), msg('c')];
  const session = [
    user('start'), msg('a'),
    user('folders complicated'), msg('mid'),
    user('restructure'), msg('mid2'),
    user('reboot'), msg('b'),
    user('now good?'), msg('n'),
    user('disk'), msg('c'),
  ];
  const out = mergeEventLines(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, [
    'start',
    'folders complicated',
    'restructure',
    'reboot',
    'now good?',
    'disk',
  ]);
  assert.ok(out.includes(msg('a')));
  assert.ok(out.includes(msg('b')));
  assert.ok(out.includes(msg('mid')));
});


test('sessionLinesToEvents emits Grok auto-compact as session_summary_generated', () => {
  const raw = [
    JSON.stringify({ type: 'user', synthetic_reason: 'compaction_meta', content: '<user_info>os</user_info>' }),
    JSON.stringify({ type: 'user', content: '<user_query>hello</user_query>' }),
    JSON.stringify({
      type: 'user',
      synthetic_reason: 'compaction_meta',
      content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Did stuff\n\nFull verbatim rollouts of previous segments are available. Do NOT modify these files.',
    }),
    JSON.stringify({ type: 'user', content: '<user_query>after compact</user_query>' }),
  ].join('\n');
  const ev = sessionLinesToEvents(raw).map((l) => JSON.parse(l));
  const names = ev.map((o) => o.event);
  assert.deepEqual(names, [
    'user_message', 'prompt_complete', 'session_summary_generated',
    'user_message', 'prompt_complete',
  ]);
  assert.match(ev[2].data.summary, /Summary:/);
  assert.doesNotMatch(ev[2].data.summary, /Do NOT modify/);
  assert.equal(ev[3].data.text, 'after compact');
});

test('extractCompactionSummary ignores user_info wrappers', () => {
  assert.equal(extractCompactionSummary('<user_info>linux</user_info>'), '');
  assert.ok(extractCompactionSummary('This session is being continued from a previous conversation. Summary: x').startsWith('This session'));
});

test('compact notice is omitted when the journal still has the full conversation', () => {
  const journal = [user('old 1'), msg('a'), user('old 2'), msg('b'), user('after compact'), msg('c')];
  const session = [
    user('after compact'),
    JSON.stringify({ event: 'session_summary_generated', eventId: 'c1', data: { summary: 'Context compacted' } }),
    user('after compact'),
    msg('c'),
  ];
  // sessionLines grouping: after compact + compact + after compact
  const out = mergeEventLines(journal, [
    user('after compact'),
    JSON.stringify({ event: 'session_summary_generated', eventId: 'c1', data: { summary: 'Context compacted' } }),
  ]);
  const names = out.map((l) => JSON.parse(l).event);
  assert.equal(names.includes('session_summary_generated'), false);
  assert.ok(out.filter((l) => l.includes('"user_message"')).length >= 3);
});

test('compact notice inserts only when the journal is not longer than the session', () => {
  const journal = [user('after compact'), msg('b')];
  const session = [
    JSON.stringify({ event: 'session_summary_generated', eventId: 'c1', data: { summary: 'Context compacted' } }),
    user('after compact'),
    msg('b'),
  ];
  const out = mergeEventLines(journal, session);
  const names = out.map((l) => JSON.parse(l).event);
  assert.deepEqual(names, [
    'session_summary_generated',
    'user_message',
    'agent_message_chunk',
  ]);
});


test('empty journal turn receives session reply', () => {
  const journal = [user('first'), msg('a'), user('Issue fixed?'), user('next')];
  const session = [user('first'), msg('a'), user('Issue fixed?'), msg('yes it is'), user('next'), msg('later')];
  const out = mergeEventLines(journal, session);
  const names = out.map((l) => JSON.parse(l).event);
  assert.deepEqual(names, [
    'user_message', 'agent_message_chunk',
    'user_message', 'agent_message_chunk',
    'user_message', 'agent_message_chunk',
  ]);
  assert.ok(out.includes(msg('yes it is')));
  assert.ok(out.includes(msg('later')));
});

test('journal reply is kept when session also has one', () => {
  const journal = [user('same'), msg('journal reply')];
  const session = [user('same'), msg('session reply')];
  const out = mergeEventLines(journal, session);
  assert.ok(out.includes(msg('journal reply')));
  assert.equal(out.includes(msg('session reply')), false);
});

test('later session reply wins when journal turn is empty', () => {
  const journal = [user('q')];
  const session = [user('q'), msg('short'), user('q'), msg('longer answer')];
  const out = mergeEventLines(journal, session);
  assert.ok(out.includes(msg('longer answer')));
  assert.equal(out.includes(msg('short')), false);
});

test('compaction worker prompt is synthetic', () => {
  assert.equal(
    isSyntheticUserText('Your task is to produce a faithful, concise summary of the conversation so far so that a successor assistant can continue'),
    true,
  );
});

test('sessionLinesToEvents reads array content for user and assistant', () => {
  const raw = [
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>Issue fixed?</user_query>' }] }),
    JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Not yet.' }] }),
  ].join('\n');
  const ev = sessionLinesToEvents(raw).map((l) => JSON.parse(l));
  assert.equal(ev[0].event, 'user_message');
  assert.equal(ev[0].data.text, 'Issue fixed?');
  assert.equal(ev[1].event, 'agent_message_chunk');
  assert.match(JSON.stringify(ev[1]), /Not yet/);
});

test('journalTurnCount skips compact on a history tail', () => {
  const journal = [user('recent 1'), msg('a'), user('recent 2'), msg('b')];
  const session = [
    JSON.stringify({ event: 'session_summary_generated', eventId: 'c1', data: { summary: 'This session is being continued from a previous conversation' } }),
    user('recent 1'), msg('a'),
    user('recent 2'), msg('b'),
  ];
  const out = mergeEventLines(journal, session, { journalTurnCount: 80 });
  const names = out.map((l) => JSON.parse(l).event);
  assert.equal(names.includes('session_summary_generated'), false);
});

test('lastUserTurnHasAssistant is true when the last user has a reply', () => {
  const raw = [
    JSON.stringify({ event: 'user_message', data: { text: 'a' } }),
    JSON.stringify({ event: 'agent_message_chunk', data: { update: { content: { text: 'ok' } } } }),
  ].join('\n');
  assert.equal(lastUserTurnHasAssistant(raw), true);
  assert.equal(lastUserTurnHasAssistant(JSON.stringify({ event: 'user_message', data: { text: 'a' } })), false);
});


test('concatSessionEvents keeps unique turns from an older leftover and a live tail', () => {
  const older = [
    user('Cannot see any output for previous turn'),
    msg('old reply'),
    user('relocation your chat folder location'),
    msg('moved'),
  ];
  const live = [
    user('Why the name keep changing?'),
    msg('because auto title'),
  ];
  const out = concatSessionEvents([older, live]);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, [
    'Cannot see any output for previous turn',
    'relocation your chat folder location',
    'Why the name keep changing?',
  ]);
});

test('concatSessionEvents drops a live replay of an older user turn', () => {
  const older = [user('same question'), msg('first')];
  const live = [user('same question'), msg('replay')];
  const out = concatSessionEvents([older, live]);
  const users = out.filter((l) => l.includes('"user_message"'));
  assert.equal(users.length, 1);
  assert.ok(out.includes(msg('first')));
  assert.equal(out.includes(msg('replay')), false);
});

test('appendNewerSessionTurns adds TUI-only turns after the journal tail', () => {
  const journal = [user('dup chats'), msg('working')];
  const session = [
    user('dup chats'), msg('working'),
    user('now http 502'), msg('backend was down'),
    user('UI resumed, but didnt got latest chat record'), msg('checking'),
  ];
  const out = appendNewerSessionTurns(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, [
    'dup chats',
    'now http 502',
    'UI resumed, but didnt got latest chat record',
  ]);
});

test('appendNewerSessionTurns does not prepend older leftover TUI users', () => {
  const journal = [user('why name'), msg('a'), user('dup chats'), msg('b')];
  const session = [
    user('old relocate'), msg('moved'),
    user('why name'), msg('a'),
    user('dup chats'), msg('b'),
    user('now http 502'), msg('down'),
  ];
  const out = appendNewerSessionTurns(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['why name', 'dup chats', 'now http 502']);
});

test('mergeEventLines on a first-load tail does not splice leftover TUI users', () => {
  const journal = [user('why name'), msg('a'), user('dup chats'), msg('b')];
  const session = [
    user('old relocate'), msg('moved'),
    user('why name'), msg('a'),
    user('dup chats'), msg('b'),
    user('now http 502'), msg('down'),
  ];
  const merged = mergeEventLines(journal, session, { journalTurnCount: 80 });
  const out = appendNewerSessionTurns(merged, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['why name', 'dup chats', 'now http 502']);
});

test('appendNewerSessionTurns does not end load on a TUI user with no reply', () => {
  const journal = [user('older q'), msg('older a')];
  const session = [
    user('older q'), msg('older a'),
    user('newest question still open'),
  ];
  const out = appendNewerSessionTurns(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['older q']);
  assert.ok(out.some((l) => l.includes('older a')));
  assert.equal(out.some((l) => l.includes('newest question still open')), false);
});


test('appendNewerSessionTurns does not dump a non-overlapping TUI session after the tail', () => {
  const journal = [user('web only q1'), msg('web a1'), user('web only q2'), msg('web a2')];
  const session = [
    user('old tui q'), msg('old tui grok reply that looks current if appended'),
    user('another old'), msg('another outdated grok response'),
  ];
  const out = appendNewerSessionTurns(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['web only q1', 'web only q2']);
  assert.equal(out.some((l) => l.includes('outdated grok')), false);
});

test('appendNewerSessionTurns ignores a huge leftover extra after a false overlap', () => {
  const journal = [user('ok'), msg('journal latest')];
  const session = [user('ok'), msg('old')];
  for (let i = 0; i < 12; i++) {
    session.push(user('leftover ' + i), msg('outdated grok ' + i));
  }
  const out = appendNewerSessionTurns(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['ok']);
});

test('appendNewerSessionTurns drops a short leftover extra after a false overlap', () => {
  const journal = [user('ok'), msg('journal latest landing pad')];
  const session = [
    user('ok'), msg('old'),
    user('leftover a'), msg('outdated grok a'),
    user('leftover b'), msg('outdated grok b'),
    user('leftover c'), msg('outdated grok c'),
  ];
  const out = appendNewerSessionTurns(journal, session);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['ok']);
  assert.ok(out.some((l) => l.includes('landing pad')));
  assert.equal(out.some((l) => l.includes('outdated grok')), false);
});

test('appendNewerSessionTurns keeps journal landing pad when TUI has older hello after a duplicate user', () => {
  const journal = [user('where do we land'), msg('landing pad')];
  const session = [
    user('where do we land'), msg('hello'),
    user('where do we land'), msg('hello'),
    user('leftover compact prompt'), msg('hello'),
  ];
  const merged = mergeEventLines(journal, session);
  const out = appendNewerSessionTurns(merged, session);
  const last = [...out].reverse().find((l) => l.includes('"agent_message_chunk"')) || '';
  assert.match(last, /landing pad/);
  assert.equal(last.includes('hello'), false);
  const users = out.filter((l) => l.includes('"user_message"')).map((l) => JSON.parse(l).data.text);
  assert.deepEqual(users, ['where do we land']);
});
