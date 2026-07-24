import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioMixer } from './audio.ts';

// Fake WebAudio : compte les contextes créés et les disconnect(), pour vérifier ce qui n'a
// aucun symptôme visible à l'exécution — un nœud oublié continue de tirer sur sa piste.

class FakeNode {
  disconnected = 0;
  disconnect(): void {
    this.disconnected++;
  }
}
class FakeSource extends FakeNode {
  connectedTo: unknown = null;
  connect(dest: unknown): void {
    this.connectedTo = dest;
  }
}
class FakeDest extends FakeNode {
  readonly stream = { getAudioTracks: () => [{ kind: 'audio', id: 'mixed' }] };
}
class FakeContext {
  closed = 0;
  readonly nodes: FakeNode[] = [];
  createMediaStreamDestination(): FakeDest {
    const d = new FakeDest();
    this.nodes.push(d);
    return d;
  }
  createMediaStreamSource(): FakeSource {
    const s = new FakeSource();
    this.nodes.push(s);
    return s;
  }
  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}

// `new MediaStream([track])` n'existe pas sous Node. Coquille vide assumée : le FakeContext
// ignore l'argument de createMediaStreamSource, personne ne relit les pistes.
globalThis.MediaStream = class {} as unknown as typeof MediaStream;

const track = (id: string) => ({ kind: 'audio', id, stop: () => {} }) as unknown as MediaStreamTrack;
const micStream = () => ({ getAudioTracks: () => [track('mic')], getTracks: () => [track('mic')] }) as unknown as MediaStream;

/** Mixer + compteur de contextes créés, avec un seul FakeContext réutilisé s'il est redemandé.
 *  `getMic` est injecté (comme makeContext) → plus besoin de forcer le champ privé micStream. */
function harness(getMic: () => Promise<MediaStream> = () => Promise.resolve(micStream())) {
  const contexts: FakeContext[] = [];
  const mixer = new AudioMixer(() => {
    const c = new FakeContext();
    contexts.push(c);
    return c as unknown as AudioContext;
  }, getMic);
  return { mixer, contexts };
}

test('mixing twice reuses the same AudioContext', async () => {
  const { mixer, contexts } = harness();
  await mixer.build(track('sys'), false);
  assert.equal(contexts.length, 0, 'une source unique passe en direct : aucun contexte');

  // Deux sources (système + micro injecté) → il faut mixer.
  const { mixer: m2, contexts: c2 } = harness();
  await m2.build(track('sys'), true);
  assert.equal(c2.length, 1, 'premier mix : un contexte');
  await m2.build(track('sys2'), true);
  assert.equal(c2.length, 1, 'second mix : le contexte est réutilisé, pas recréé');
});

test('the mic is acquired once, not re-prompted on a source change', async () => {
  let prompts = 0;
  const { mixer } = harness(() => {
    prompts++;
    return Promise.resolve(micStream());
  });
  await mixer.build(track('sys'), true);
  await mixer.build(track('sys2'), true); // source changed, mic still on
  assert.equal(prompts, 1, 'getUserMedia n’est appelé qu’au passage micro off→on');
});

test('a denied mic rejects the build (the host self-heals by retrying without it)', async () => {
  const { mixer } = harness(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
  await assert.rejects(mixer.build(track('sys'), true), /denied/);
});

test('a rebuild disconnects the previous graph', async () => {
  const { mixer, contexts } = harness();
  await mixer.build(track('sys'), true);
  const first = [...contexts[0].nodes];
  assert.equal(first.length, 3, 'une destination + deux sources');
  assert.ok(
    first.every((n) => n.disconnected === 0),
    'le graphe courant reste connecté',
  );

  await mixer.build(track('sys2'), true);
  assert.ok(
    first.every((n) => n.disconnected === 1),
    'les nœuds du build précédent sont libérés — sinon ils continuent de tirer sur leur piste',
  );
});

test('teardown disconnects the graph and closes the context', async () => {
  const { mixer, contexts } = harness();
  await mixer.build(track('sys'), true);
  mixer.teardown();
  assert.equal(contexts[0].closed, 1, 'teardown est le seul endroit qui ferme le contexte');
  assert.ok(
    contexts[0].nodes.every((n) => n.disconnected === 1),
    'et il libère aussi le graphe courant',
  );
});
