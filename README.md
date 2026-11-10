# grok-remote

Version **0.2.0**. A browser UI for Grok Build: several conversations on one machine, each with its own `grok` process, openable from a phone or another browser.

This tree started from [daniel-farina/grok-remote](https://github.com/daniel-farina/grok-remote). The MIT notice is in [LICENSE](./LICENSE). The pages below describe this copy.

Not affiliated with xAI.

## What this copy does

- Each conversation is its own `grok` process, kept in a sibling container named `gr-hold-<id>`. Restarting the website attaches to that process. It does not start a new session.
- The server speaks the Agent Client Protocol to the hold and forwards thoughts, tool cards, and the reply to the browser over server-sent events.
- `~/.grok-remote/agents/<id>/history.jsonl` is the conversation record. `GET /api/agents/:id/history` only reads it. Grok's `chat_history.jsonl` fills gaps. A read never rewrites the journal.
- Sign-in is OIDC when `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` are set. Otherwise the server starts with OIDC off.
- The `grok` binary follows `~/.grok/bin/grok` when `GROK_BIN` is the container path `/usr/local/bin/grok`. Any other `GROK_BIN` still wins (`lib/grok-bin.ts`).

## Behavior kept in this copy

- Replies render as markdown. A slash command with no required argument runs on Enter. `@` searches files in the conversation folder.
- A message queued while the agent is busy sends itself when the turn finishes.
- Stream chunks are merged so a short piece of text, including one CJK character, is not dropped as a duplicate (`lib/stream-text.ts`).
- After Compact, the token total updates only when the new number is lower.
- Resume (`-r`) restreams the old session before `session_ready`. Those rows are not shown and are not written again. The journal file is left as it is (`lib/attach-replay.ts`).

## Run

Node 20:

```sh
node --import tsx server.ts
```

The process listens on `PORT` (default `7910`), serves `dist/`, and exposes `/api`. `/api/health` and `/api/hello` do not require a login.

On the machine this copy runs on, that process is the `grok-remote` container. After a code change:

```sh
node --import tsx --test test/<touched>.test.ts
npx vite build
docker restart grok-remote
```

Skip the Vite build when only `lib/` or `server.ts` changed. Restart the website container only. Do not remove `gr-hold-*`. If a hold socket is missing, wait. Do not replace the container to get the socket back.

`./install.sh`, PM2, and the `gr` command are still in the tree. They are the upstream installer. They are not what supervises this copy.

## Develop

```sh
npm install
npm test
npm run dev
npm run typecheck
```

`npm run dev` starts Vite on port `7911` and proxies `/api` to `7910`.

`NODE_ENV=production` makes `npm install` omit devDependencies, including `tsx` and `vite`. Put them back with `npm install --include=dev` before restarting the server.

The dashboard is TypeScript in `src/`. The flow page is the React part. Server modules are in `lib/`. Who owns which file is [ARCHITECTURE.md](./ARCHITECTURE.md). The wire format is [PROTOCOL.md](./PROTOCOL.md).

## Files on disk

```
~/.grok-remote/
├── settings.json
└── agents/
    └── <agent-uuid>/
        ├── meta.json
        ├── history.jsonl
        └── cwd/
```

Grok's own session files stay under `~/.grok/sessions/`. They are separate from the website journal.

## License

MIT. Copyright (c) 2026 Daniel Farina. See [LICENSE](./LICENSE).
