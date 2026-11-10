import { el } from './render';
import { copyToClipboard } from './copy';

export function cwdTail(cwd: string): string {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  const parts = raw.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return raw;
  return '…/' + parts.slice(-2).join('/');
}

export function mountCwdChip(): HTMLButtonElement {
  return el('button', {
    type: 'button',
    class: 'cwd-chip',
    hidden: true,
    title: '',
  }) as HTMLButtonElement;
}

export function paintCwdChip(node: HTMLButtonElement, cwd: string | null | undefined): void {
  const path = String(cwd || '').trim();
  if (!path) {
    node.hidden = true;
    node.replaceChildren();
    node.onclick = null;
    node.title = '';
    return;
  }
  node.hidden = false;
  node.title = path + ' — tap to copy. Relocate from Conversation Settings → Folder.';
  node.replaceChildren(
    el('span', { class: 'cwd-chip__kicker' }, 'Folder'),
    el('span', { class: 'cwd-chip__path' }, cwdTail(path)),
  );
  node.onclick = async () => {
    const ok = await copyToClipboard(path);
    node.classList.toggle('is-copied', ok);
    window.setTimeout(() => node.classList.remove('is-copied'), 900);
  };
}
