// Toggle one boolean in a toml config without rewriting the rest of the file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FEATURE_SECTION = 'features';
const FEATURE_KEY = 'subagent_model_inheritance';

function sectionHeader(section: string): string {
  return `[${section}]`;
}

function findSection(lines: string[], section: string): { start: number; end: number } | null {
  const header = sectionHeader(section);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim();
    const isHeader = trim.startsWith('[') && trim.endsWith(']') && !trim.startsWith('[[');
    if (!isHeader) continue;
    if (start >= 0) return { start, end: i };
    if (trim === header) start = i;
  }
  if (start >= 0) return { start, end: lines.length };
  return null;
}

export function readTomlSectionBool(text: string, section: string, key: string): boolean | null {
  const lines = String(text || '').split(/\r?\n/);
  const span = findSection(lines, section);
  if (!span) return null;
  const re = new RegExp(`^${key}\\s*=\\s*(true|false)\\s*$`, 'i');
  for (let i = span.start + 1; i < span.end; i++) {
    const trim = lines[i].trim();
    if (!trim || trim.startsWith('#')) continue;
    const m = trim.match(re);
    if (m) return m[1].toLowerCase() === 'true';
  }
  return null;
}

export function setTomlSectionBool(text: string, section: string, key: string, value: boolean): string {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const rendered = `${key} = ${value ? 'true' : 'false'}`;
  const span = findSection(lines, section);
  if (span) {
    const re = new RegExp(`^${key}\\s*=`);
    for (let i = span.start + 1; i < span.end; i++) {
      const trim = lines[i].trim();
      if (trim.startsWith('#')) continue;
      if (re.test(trim)) {
        lines[i] = rendered;
        return lines.join('\n');
      }
    }
    lines.splice(span.end, 0, rendered);
    return lines.join('\n');
  }
  const base = src.length && !src.endsWith('\n') ? `${src}\n` : src;
  const gap = base.length && !base.endsWith('\n\n') ? '\n' : '';
  return `${base}${gap}[${section}]\n${rendered}\n`;
}

function grokConfigFile(): string {
  const env = String(process.env['GROK_HOME'] || '').trim();
  const home = env || path.join(os.homedir(), '.grok');
  return path.join(home, 'config.toml');
}

export function readSubagentInheritance(): boolean | null {
  try {
    return readTomlSectionBool(fs.readFileSync(grokConfigFile(), 'utf8'), FEATURE_SECTION, FEATURE_KEY);
  } catch {
    return null;
  }
}

export function writeSubagentInheritance(value: boolean): void {
  const file = grokConfigFile();
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = ''; }
  const next = setTomlSectionBool(cur, FEATURE_SECTION, FEATURE_KEY, value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next.endsWith('\n') ? next : `${next}\n`);
  fs.renameSync(tmp, file);
}
