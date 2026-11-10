import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownTable, tableToCsv, tableToMarkdown, tableToTsv } from '../src/lib/render/md-table.ts';

test('markdown table exports tsv, csv, and markdown', () => {
  const table = parseMarkdownTable('| A | B |\n| --- | --- |\n| x, y | z |\n| 1 | 2 |');
  assert.ok(table);
  assert.deepEqual(table!.headers, ['A', 'B']);
  assert.equal(tableToTsv(table!), 'A\tB\nx, y\tz\n1\t2');
  assert.equal(tableToCsv(table!), 'A,B\n"x, y",z\n1,2');
  assert.match(tableToMarkdown(table!), /\| A \| B \|/);
});
