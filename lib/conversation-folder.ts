// Turn a Folder field value into a project path.
// A bare name is created under /home/opc/grok-projects/.

export const PROJECTS_ROOT = '/home/opc/grok-projects';

export function resolveFolderInput(input: string, projectsRoot = PROJECTS_ROOT): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) {
    const trimmed = raw.replace(/\/+$/, '');
    return trimmed || '/';
  }
  const name = raw.replace(/[\\/]+/g, '-').replace(/^\.+/, '').trim();
  if (!name) return '';
  return `${String(projectsRoot || PROJECTS_ROOT).replace(/\/+$/, '')}/${name}`;
}

export function projectGroupName(
  cwd: string,
  projectsRoot = PROJECTS_ROOT,
  home = '/home/opc',
): string {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  const n = raw.replace(/\/+$/, '') || '';
  if (!n || n === '/') return '';
  const norm = n.replace(/\\/g, '/');
  if (norm.includes('/.grok-remote/agents/')) return '';
  if (norm === '/tmp' || norm.startsWith('/tmp/') || norm === '/var/tmp' || norm.startsWith('/var/tmp/')) return '';
  const root = String(projectsRoot || PROJECTS_ROOT).replace(/\/+$/, '');
  if (n === root) return 'Projects';
  if (root && n.startsWith(root + '/')) {
    const rest = n.slice(root.length).replace(/^\/+/, '');
    return titleCaseSegs(rest) || 'Projects';
  }
  if (home) {
    const h = String(home).replace(/\/+$/, '');
    if (n === h) return 'Home';
  }
  const base = n.split('/').filter(Boolean).pop() || n;
  return titleCaseSegs(base);
}

function titleCaseSegs(s: string): string {
  return String(s || '')
    .split(/[/_\-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Reverse a sidebar folder title like "Grok Remote" into a project path. */
export function folderNameToCwd(
  name: string,
  projectsRoot = PROJECTS_ROOT,
  home = '/home/opc',
): string {
  const n = String(name || '').trim();
  if (!n) return '';
  if (n.toLowerCase() === 'home') return String(home).replace(/\/+$/, '') || home;
  if (n.toLowerCase() === 'projects') return String(projectsRoot).replace(/\/+$/, '');
  const slug = n.replace(/\s+/g, '-').toLowerCase();
  return resolveFolderInput(slug, projectsRoot);
}

/** Prefer an existing sibling cwd in that folder; otherwise derive from the folder name. */
export function inferCwdForFolder(opts: {
  folderName?: string | null;
  siblingCwds?: Array<string | null | undefined>;
  projectsRoot?: string;
  home?: string;
}): string {
  const counts = new Map<string, number>();
  for (const raw of opts.siblingCwds || []) {
    const c = String(raw || '').replace(/\/+$/, '');
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  if (counts.size) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  }
  return folderNameToCwd(opts.folderName || '', opts.projectsRoot, opts.home);
}
