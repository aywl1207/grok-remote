import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLDER_PREVIEW_COUNT,
  folderShowMoreLabel,
  previewFolderItems,
} from '../src/views/agents/folder-preview.ts';

function n(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, i) => ({ id: `c${i}` }));
}

test('previewFolderItems caps a large folder and reports hidden count', () => {
  const out = previewFolderItems({
    items: n(50),
    selectedId: null,
    expanded: false,
    searching: false,
  });
  assert.equal(out.shown.length, FOLDER_PREVIEW_COUNT);
  assert.equal(out.hidden, 50 - FOLDER_PREVIEW_COUNT);
  assert.equal(out.scroll, false);
  assert.equal(out.shown[0]!.id, 'c0');
});

test('previewFolderItems keeps the open chat even when it is past the cap', () => {
  const out = previewFolderItems({
    items: n(50),
    selectedId: 'c40',
    expanded: false,
    searching: false,
  });
  assert.equal(out.shown.length, FOLDER_PREVIEW_COUNT + 1);
  assert.equal(out.shown[out.shown.length - 1]!.id, 'c40');
  assert.equal(out.hidden, 50 - out.shown.length);
});

test('previewFolderItems shows everything when expanded and enables inner scroll', () => {
  const out = previewFolderItems({
    items: n(50),
    selectedId: 'c0',
    expanded: true,
    searching: false,
  });
  assert.equal(out.shown.length, 50);
  assert.equal(out.hidden, 0);
  assert.equal(out.scroll, true);
});

test('previewFolderItems does not cap search matches, but still scrolls', () => {
  const out = previewFolderItems({
    items: n(20),
    selectedId: null,
    expanded: false,
    searching: true,
  });
  assert.equal(out.shown.length, 20);
  assert.equal(out.hidden, 0);
  assert.equal(out.scroll, true);
});

test('previewFolderItems leaves small folders alone', () => {
  const out = previewFolderItems({
    items: n(3),
    selectedId: 'c2',
    expanded: false,
    searching: false,
  });
  assert.equal(out.shown.length, 3);
  assert.equal(out.hidden, 0);
  assert.equal(out.scroll, false);
});

test('folderShowMoreLabel is readable', () => {
  assert.equal(folderShowMoreLabel(1), 'Show 1 more');
  assert.equal(folderShowMoreLabel(42), 'Show 42 more');
});
