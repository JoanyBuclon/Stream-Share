// Host roster reconcile: the set diff that decides who to add/drop after a reclaim. A regression
// here (e.g. iterating a live map while mutating it) would silently add or drop the wrong viewers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRoster } from './roster.ts';

test('adds joiners and drops leavers against the server truth', () => {
  const current = ['p1', 'p2', 'p3']; // p2 left during the outage, p4 joined
  const incoming = [
    { peerId: 'p1', pseudo: 'a' },
    { peerId: 'p3', pseudo: 'c' },
    { peerId: 'p4', pseudo: 'd' },
  ];
  const { toRemove, toAdd } = reconcileRoster(current, incoming);
  assert.deepEqual(toRemove, ['p2']);
  assert.deepEqual(toAdd, [{ peerId: 'p4', pseudo: 'd' }]);
});

test('no change when the rosters already match', () => {
  const current = ['p1', 'p2'];
  const incoming = [
    { peerId: 'p1', pseudo: 'a' },
    { peerId: 'p2', pseudo: 'b' },
  ];
  const { toRemove, toAdd } = reconcileRoster(current, incoming);
  assert.deepEqual(toRemove, []);
  assert.deepEqual(toAdd, []);
});

test('an empty server truth drops everyone; a fresh host adds all', () => {
  assert.deepEqual(reconcileRoster(['p1', 'p2'], []).toRemove, ['p1', 'p2']);
  const all = reconcileRoster([], [{ peerId: 'p1', pseudo: 'a' }]);
  assert.deepEqual(all.toAdd, [{ peerId: 'p1', pseudo: 'a' }]);
  assert.deepEqual(all.toRemove, []);
});
