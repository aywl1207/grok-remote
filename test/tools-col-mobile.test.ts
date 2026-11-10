import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileToolsStartCollapsed, closeToolsCol, readToolsColTab } from '../src/views/chat/tools-col.js';

test('mobile tools start collapsed unless the user saved open', () => {
  assert.equal(mobileToolsStartCollapsed(null), true);
  assert.equal(mobileToolsStartCollapsed('1'), true);
  assert.equal(mobileToolsStartCollapsed('0'), false);
});

test('tools column tab is always tool calls, never files', () => {
  assert.equal(readToolsColTab(), 'tools');
});

test('closeToolsCol exits fullscreen and collapses the panel', () => {
  const view: any = {
    _toolsColFullscreen: true,
    _chatSplitCollapsed: false,
    _splitFullscreenBtn: null,
    _applyToolsFullscreenClass() { this.applied = true; },
    _toggleToolsCol() { this._chatSplitCollapsed = !this._chatSplitCollapsed; },
  };
  closeToolsCol(view);
  assert.equal(view._toolsColFullscreen, false);
  assert.equal(view._chatSplitCollapsed, true);
  assert.equal(view.applied, true);
});

test('closeToolsCol is a no-op when already collapsed', () => {
  let toggles = 0;
  const view: any = {
    _toolsColFullscreen: false,
    _chatSplitCollapsed: true,
    _splitFullscreenBtn: null,
    _applyToolsFullscreenClass() {},
    _toggleToolsCol() { toggles += 1; },
  };
  closeToolsCol(view);
  assert.equal(toggles, 0);
  assert.equal(view._chatSplitCollapsed, true);
});
