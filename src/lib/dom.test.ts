// initials() builds the viewer-row avatar from a nickname. Pure — the rest of dom.ts is thin
// wrappers over document, exercised by the e2e specs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials } from './dom.ts';

test('initials takes up to two letters, uppercased', () => {
  assert.equal(initials('joany'), 'JO');
  assert.equal(initials('joany buclon'), 'JB');
  assert.equal(initials('a'), 'A');
  assert.equal(initials('joany max buclon'), 'JM', 'first two words only');
});

test('initials collapses surrounding and inner whitespace', () => {
  assert.equal(initials('  joany  buclon  '), 'JB');
  assert.equal(initials('joany\tbuclon'), 'JB');
});

test('initials falls back to ? on an empty or blank name', () => {
  assert.equal(initials(''), '?');
  assert.equal(initials('   '), '?');
});
