import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serial } from './serial.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('serial: exécute dans l ordre, jamais en chevauchement', async () => {
  const run = serial();
  const log: string[] = [];
  const task = (id: string, ms: number) => async () => {
    log.push(`${id}+`);
    await delay(ms);
    log.push(`${id}-`);
  };
  const p1 = run(task('a', 20));
  const p2 = run(task('b', 1)); // plus court, mais doit attendre la fin de a
  await Promise.all([p1, p2]);
  assert.deepEqual(log, ['a+', 'a-', 'b+', 'b-']);
});

test('serial: une tâche qui jette ne bloque pas la suivante', async () => {
  const run = serial();
  const log: string[] = [];
  const p1 = run(async () => {
    throw new Error('boom');
  });
  const p2 = run(async () => {
    log.push('ok');
  });
  await assert.rejects(p1);
  await p2;
  assert.deepEqual(log, ['ok']);
});
