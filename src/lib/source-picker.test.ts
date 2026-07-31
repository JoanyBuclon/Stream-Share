// The picker's only real logic is the search filter — everything else is DOM wiring. A source
// list on Windows is dozens of window titles, so a filter that is case-sensitive, or that treats
// a blank query as "match nothing", hides sources the user can see on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery } from './source-picker.ts';

test('a blank query matches everything', () => {
  assert.equal(matchesQuery('Screen 1', ''), true);
  assert.equal(matchesQuery('Screen 1', '   '), true);
});

test('matching is case-insensitive and on any substring', () => {
  assert.equal(matchesQuery('Google Chrome', 'chrome'), true);
  assert.equal(matchesQuery('Google Chrome', 'GOOGLE'), true);
  assert.equal(matchesQuery('Visual Studio Code', 'studio'), true);
  assert.equal(matchesQuery('Discord', 'steam'), false);
});

test('the query is trimmed, the name is not', () => {
  // Window titles arrive from the OS and often carry padding; trimming the query alone keeps a
  // trailing space in a typed name from emptying the grid.
  assert.equal(matchesQuery('Elden Ring', '  elden '), true);
  assert.equal(matchesQuery(' Steam ', 'steam'), true);
});
