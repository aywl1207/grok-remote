// Markdown table parse + clipboard exports. No DOM.

export interface MdTable {
  headers: string[];
  rows: string[][];
}

function splitCells(line: string): string[] {
  let s = String(line || '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  const cells = splitCells(line);
  if (cells.length < 2) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s+/g, '')));
}

export function parseMarkdownTable(text: string): MdTable | null {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l);
  if (lines.length < 2) return null;
  if (!lines[0].includes('|') || !isSeparator(lines[1])) return null;
  const headers = splitCells(lines[0]);
  if (headers.length < 2) return null;
  const rows: string[][] = [];
  for (const line of lines.slice(2)) {
    if (!line.includes('|')) break;
    const cells = splitCells(line);
    if (cells.length < 2) break;
    while (cells.length < headers.length) cells.push('');
    rows.push(cells.slice(0, headers.length));
  }
  return { headers, rows };
}

/** Pull the first table out of a prose block. Returns null when the block is not a table. */
export function parseFirstMarkdownTable(text: string): MdTable | null {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|')) continue;
    if (!isSeparator(lines[i + 1] || '')) continue;
    const chunk: string[] = [lines[i], lines[i + 1]];
    for (let j = i + 2; j < lines.length; j++) {
      if (!String(lines[j] || '').trim() || !lines[j].includes('|')) break;
      chunk.push(lines[j]);
    }
    const table = parseMarkdownTable(chunk.join('\n'));
    if (table) return table;
  }
  return null;
}

function csvCell(value: string): string {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function tableToTsv(table: MdTable): string {
  const line = (cells: string[]) => cells.map((c) => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t');
  return [line(table.headers), ...table.rows.map(line)].join('\n');
}

export function tableToCsv(table: MdTable): string {
  const line = (cells: string[]) => cells.map(csvCell).join(',');
  return [line(table.headers), ...table.rows.map(line)].join('\n');
}

export function tableToMarkdown(table: MdTable): string {
  const esc = (c: string) => String(c ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const head = `| ${table.headers.map(esc).join(' | ')} |`;
  const sep = `| ${table.headers.map(() => '---').join(' | ')} |`;
  const body = table.rows.map((row) => `| ${row.map(esc).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

export type MdBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'table'; table: MdTable };

export function splitProseAndTables(text: string): MdBlock[] {
  const lines = String(text || '').split(/\r?\n/);
  const out: MdBlock[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (!prose.length) return;
    out.push({ kind: 'prose', text: prose.join('\n') });
    prose = [];
  };
  let i = 0;
  while (i < lines.length) {
    const next = lines[i + 1] || '';
    if (lines[i].includes('|') && isSeparator(next)) {
      const headers = splitCells(lines[i]);
      if (headers.length >= 2) {
        flush();
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && String(lines[i]).trim()) {
          const cells = splitCells(lines[i]);
          if (cells.length < 2) break;
          while (cells.length < headers.length) cells.push('');
          rows.push(cells.slice(0, headers.length));
          i += 1;
        }
        out.push({ kind: 'table', table: { headers, rows } });
        continue;
      }
    }
    prose.push(lines[i]);
    i += 1;
  }
  flush();
  return out;
}
