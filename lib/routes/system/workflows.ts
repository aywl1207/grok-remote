import type { IncomingMessage, ServerResponse } from 'node:http';

import { send } from '../helpers.js';
import { listSavedWorkflows } from '../../workflows.js';
import type { RouteRegistrar } from '../system.js';

export function register(add: RouteRegistrar): void {
  add('GET', '/api/system/workflows', handleList);
}

function handleList(_req: IncomingMessage, res: ServerResponse): void {
  send(res, 200, { ok: true, items: listSavedWorkflows() });
}
