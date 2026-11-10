# grok-remote layout

Read this before editing. Keep modules small enough that an agent can load one file and know the contract.

## Where things live

| Path | Owns |
| --- | --- |
| `server.ts` | HTTP listen, static files, `/api` dispatch. No history compact, no ACP. |
| `lib/sse-http.ts` | Agent ring + agents-list + version-update SSE. |
| `lib/files-http.ts` | `GET /files` and `/files/raw`. Stay inside agent cwd. |
| `lib/terminals-http.ts` | Bg terminals list/read/kill. Does not touch holds. |
| `lib/history.ts` | Journal paths, append, count, tail-read, **disk** compact, **GET** compact + slice. |
| `lib/history-http.ts` | `GET /api/agents/:id/history`. Never writes the journal. |
| `lib/transcript.ts` | Merge Grok `chat_history.jsonl` **gaps** into the journal. Journal is the spine. |
| `lib/agent-hold.ts` | Sibling `gr-hold-<id>` lifecycle. Never replace a running hold. |
| `lib/acp-hold.ts` | Hold-side Unix socket proxy (runs **inside** the hold image). |
| `lib/acp-client.ts` | ACP JSON-RPC over the hold socket. |
| `lib/agent-cwd.ts` | Create/resolve a conversation Folder (`cwd`). Does not recreate holds. |
| `lib/agent-manager.ts` | In-process agent registry, SSE ring, connect/reconnect. |
| `lib/agent-status.ts` | Sidebar/header status derivation. Shared with the chat UI. |
| `lib/routes/` | `/api/system/*` only. |
| `src/views/chat.ts` | Conversation orchestrator (DOM + SSE). Thin methods; policy in `src/lib/`. |
| `src/views/chat/history-replay.ts` | Two-pass GET /history replay. |
| `src/views/chat/settings-drawer.ts` | Per-conversation settings drawer. |
| `src/views/chat/model-picker.ts` | `/model` `/effort` picker. |
| `src/views/chat/at-palette.ts` | Composer `@` file search. |
| `src/views/chat/find-bar.ts` | Scrollback find. |
| `src/lib/history-events.ts` | Which history events replay, in which pass. |
| `src/lib/sse-ring.ts` | Drop stale SSE-ring events after connect. |
| `src/lib/event-id.ts` | Live `timestamp-seq` event ids. |
| `src/lib/stream-text.ts` | Chunk merge (do not treat 1-char suffix as a duplicate). |
| `src/lib/conversation-log.ts` | When to start / ignore a You bubble. |
| `src/lib/prompt-history.ts` | Composer ↑ history. Merge from conversation; do not cap-and-stick. |
| `src/lib/render.ts` | Barrel for conversation DOM cards. |
| `src/lib/render/` | `el`, user, thought, tool, compact/toast cards. |
| `src/views/chat/tools-col.ts` | Tools column + Split.js. |
| `src/views/chat/prompt-hist.ts` | Prompt-history UI. |
| `src/views/chat/todos-pane.ts` | Todos / tasks pane. |
| `src/views/chat/composer.ts` | Send / queue / cancel. |
| `src/views/agents/sort.ts` | Sidebar sort / search. |

## Invariants (do not regress)

1. **GET /history never rewrites `history.jsonl`.** Compact the in-memory slice only. A compact-during-GET race already dropped newest turns.
2. **Journal is the long conversation.** Session transcript fills gaps (CLI / post-compact) **and** splices session thought/reply onto a journal user that has no assistant block. Insert session-only turns **between surrounding common users**, never dump them before the last common user. After Grok compact, the newest `compaction_requests/*.json` `chat_history` is an extra session source.
3. **Do not paint "Context Compacted"** when the journal still has more user turns than the session (Grok compact rewrites session only).
4. **Never `docker rm -f` a running hold** because the sock is missing. Missing sock = wait, not recreate.
5. **Restart `grok-remote` only.** Do not stop `gr-hold-*`. The grok session must survive the UI/server restart.
8. **Disconnect / archive / reconnect detach only.** Only deleting a conversation may `stopHold`.
9. **Unknown `terminalId` after reconnect is "already exited",** not a thrown RPC error.
6. History replay keeps tool cards for the **last 2 user turns** only (`collapseHistoryForReplay`).
7. Stream merge: a 1-character suffix is new text, not a duplicate (`RESTREAM_MIN = 8`).

## Where to put new code

- New **pure** decision → `src/lib/<topic>.ts` or `lib/<topic>.ts` with a test in `test/`.
- New **HTTP route** → `lib/<name>-http.ts` or `lib/routes/`, one-line call from `server.ts`.
- New **chat UI behavior** → helper first, then a thin `ChatView` method. Do not grow `chat.ts` with more policy tables.
- Do not copy `HISTORY_DROP` / compact / event-skip sets. Edit the owning module.

## Deploy

Live sources are `/opt/grok-remote`. After server or UI edits: run `node --import tsx --test` on the touched tests, `npx vite build`, then `docker restart grok-remote` only. Persist the image with `docker commit grok-remote grok-remote:local` when the change should land in new holds. Do not recreate existing holds.
