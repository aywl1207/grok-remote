// OAuth (OIDC) and Basic Auth settings pages.

import { api } from '../../lib/api.js';
import { el } from '../../lib/render.js';

interface AuthStatus {
  ok?: boolean;
  user?: { sub?: string; email?: string; name?: string } | null;
  oidc?: {
    enabled?: boolean;
    issuer?: string;
    clientId?: string;
    clientSecretSet?: boolean;
    redirectUri?: string;
    allowedEmails?: string;
    source?: string;
  };
  basic?: { enabled?: boolean; username?: string };
  error?: string;
}

let host: HTMLElement | null = null;

export function mount(container: HTMLElement, ctx?: { area?: string }): void {
  host = container;
  const area = ctx && ctx.area === 'basic-auth' ? 'basic-auth' : 'oauth';
  void render(area);
}

export function unmount(): void {
  if (host) host.replaceChildren();
  host = null;
}

async function render(area: 'oauth' | 'basic-auth'): Promise<void> {
  if (!host) return;
  host.replaceChildren(el('div', { class: 'system-page-sub' }, 'Loading…'));
  let status: AuthStatus = {};
  try { status = await api.authStatus() as AuthStatus; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    host.replaceChildren(el('div', { class: 'pane-empty' }, `Could not load sign-in settings: ${msg}`));
    return;
  }
  if (!host) return;
  host.replaceChildren(area === 'basic-auth' ? basicForm(status) : oauthForm(status));
}

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  return el('div', { class: 'field' },
    el('label', { class: 'field-label' }, label),
    control,
    help ? el('div', { class: 'field-help' }, help) : null,
  );
}

function oauthForm(status: AuthStatus): HTMLElement {
  const o = status.oidc || {};
  const enabled = el('input', { type: 'checkbox' }) as HTMLInputElement;
  enabled.checked = !!o.enabled;
  const issuer = el('input', { class: 'inp', type: 'url', placeholder: 'https://auth.example/application/o/app' }) as HTMLInputElement;
  issuer.value = String(o.issuer || '');
  const clientId = el('input', { class: 'inp', type: 'text', autocomplete: 'off' }) as HTMLInputElement;
  clientId.value = String(o.clientId || '');
  const secret = el('input', {
    class: 'inp', type: 'password', autocomplete: 'new-password',
    placeholder: o.clientSecretSet ? 'Unchanged' : 'Client secret',
  }) as HTMLInputElement;
  const redirect = el('input', { class: 'inp', type: 'url' }) as HTMLInputElement;
  redirect.value = String(o.redirectUri || 'https://grok.aykc.cloud/auth/callback');
  const emails = el('input', { class: 'inp', type: 'text', placeholder: 'Optional, comma-separated' }) as HTMLInputElement;
  emails.value = String(o.allowedEmails || '');
  const note = el('div', { class: 'settings-status' }) as HTMLElement;
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save OAuth') as HTMLButtonElement;
  save.onclick = () => {
    void (async () => {
      save.disabled = true;
      try {
        const body: Record<string, unknown> = {
          enabled: enabled.checked,
          issuer: issuer.value.trim(),
          clientId: clientId.value.trim(),
          redirectUri: redirect.value.trim(),
          allowedEmails: emails.value.trim(),
        };
        if (secret.value.trim()) body.clientSecret = secret.value.trim();
        const next = await api.saveOidc(body) as AuthStatus;
        paintNote(note, next.error ? String(next.error) : 'OAuth settings saved. New logins use this immediately.', next.error ? 'fail' : 'ok');
        secret.value = '';
        secret.placeholder = next.oidc && next.oidc.clientSecretSet ? 'Unchanged' : 'Client secret';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        paintNote(note, msg, 'fail');
      } finally {
        save.disabled = false;
      }
    })();
  };

  const user = status.user;
  const who = user && (user.email || user.name || user.sub);
  const logout = el('button', {
    class: 'btn btn--ghost', type: 'button',
    onclick: () => { window.location.href = '/auth/logout'; },
  }, 'Log out') as HTMLButtonElement;
  logout.hidden = !who;

  return el('section', { class: 'settings' },
    el('h2', { class: 'settings-title' }, 'OAuth'),
    el('p', { class: 'system-page-sub' },
      'Authentik or any OIDC provider. Off unless enabled here (or set by environment).'),
    who ? el('p', { class: 'field-help' }, `Signed in as ${who}.`) : null,
    field('Enable OAuth', el('label', { class: 'toggle' }, enabled, el('span', { class: 'toggle-text' }, 'Require Authentik / OIDC sign-in'))),
    field('Issuer', issuer, 'Example: https://auth.aykc.cloud/application/o/grok-remote'),
    field('Client ID', clientId),
    field('Client secret', secret, o.clientSecretSet ? 'Leave blank to keep the current secret.' : 'Required to enable OAuth.'),
    field('Redirect URI', redirect, 'Must match the provider app. Default is https://grok.aykc.cloud/auth/callback'),
    field('Allowed emails', emails, 'Optional allow-list. Empty means any Authentik user can sign in.'),
    note,
    el('div', { class: 'settings-actions' }, save, logout),
  );
}

function basicForm(status: AuthStatus): HTMLElement {
  const b = status.basic || {};
  const enabled = el('input', { type: 'checkbox' }) as HTMLInputElement;
  enabled.checked = !!b.enabled;
  const username = el('input', { class: 'inp', type: 'text', autocomplete: 'username' }) as HTMLInputElement;
  username.value = String(b.username || 'opc');
  const password = el('input', {
    class: 'inp', type: 'password', autocomplete: 'new-password',
    placeholder: 'Leave blank to keep the current password',
  }) as HTMLInputElement;
  const note = el('div', { class: 'settings-status' }) as HTMLElement;
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save Basic Auth') as HTMLButtonElement;
  save.onclick = () => {
    void (async () => {
      save.disabled = true;
      try {
        const body: Record<string, unknown> = {
          enabled: enabled.checked,
          username: username.value.trim(),
        };
        if (password.value) body.password = password.value;
        await api.saveBasic(body);
        password.value = '';
        paintNote(note, 'Basic Auth settings applied to the nginx front door.', 'ok');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        paintNote(note, msg, 'fail');
      } finally {
        save.disabled = false;
      }
    })();
  };

  return el('section', { class: 'settings' },
    el('h2', { class: 'settings-title' }, 'Basic Auth'),
    el('p', { class: 'system-page-sub' },
      'Nginx username and password in front of the site. Can be used with OAuth.'),
    field('Enable Basic Auth', el('label', { class: 'toggle' }, enabled, el('span', { class: 'toggle-text' }, 'Ask for a browser password'))),
    field('Username', username),
    field('Password', password, 'Required the first time you enable Basic Auth. Leave blank to keep the current hash.'),
    note,
    el('div', { class: 'settings-actions' }, save),
  );
}

function paintNote(elNode: HTMLElement, text: string, kind: string): void {
  elNode.replaceChildren(
    el('span', { class: `status-pill status-pill--${kind}` }),
    el('span', { class: 'settings-status-text' }, text),
  );
}
