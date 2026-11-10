// Pick the grok binary the website should spawn.
//
// The grok-remote container sets GROK_BIN=/usr/local/bin/grok, a read-only
// mount of an old host binary that cannot be replaced without recreating
// the container. An explicit GROK_BIN other than that path still wins
// (tests and custom installs). Otherwise follow ~/.grok/bin/grok.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_CONTAINER_BIN = '/usr/local/bin/grok';

export function resolveGrokBin(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  const fromEnv = env['GROK_BIN'];
  if (fromEnv && fromEnv !== STALE_CONTAINER_BIN) return fromEnv;
  try {
    const userBin = path.join(home, '.grok', 'bin', 'grok');
    const resolved = fs.realpathSync(userBin);
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch { /* user install missing */ }
  return fromEnv || 'grok';
}
