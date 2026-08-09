import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAudioApps,
  createWakeLockToggle,
  nativeDisplayFor,
  pickerSources,
  approvedTargetFor,
  rendererSecurity,
  type PowerBlocker,
  type NativeDisplay,
  type CapturerSource,
  type PickerDisplay,
} from './config.ts';

// The wake-lock bookkeeping fails silently by construction: get it wrong and the only symptom is a
// machine that stopped sleeping, with nothing on screen tying it back to us. Hence tests on ten
// lines. `start()` returning 0 for the first blocker is measured, not hypothetical.
function fakeBlocker(firstId = 0) {
  const log: string[] = [];
  let next = firstId;
  const blocker: PowerBlocker = {
    start: () => {
      const id = next++;
      log.push(`start->${id}`);
      return id;
    },
    stop: (id) => log.push(`stop(${id})`),
  };
  return { blocker, log };
}

test('createWakeLockToggle holds exactly one blocker, even though the first id is 0', () => {
  // The trap: `if (!id)` reads id 0 as "nothing held" and stacks a new blocker on every request,
  // leaving all but the last with no id anyone can stop.
  const { blocker, log } = fakeBlocker(0);
  const setWakeLock = createWakeLockToggle(blocker);
  setWakeLock(true);
  setWakeLock(true);
  setWakeLock(true);
  assert.deepEqual(log, ['start->0'], 'repeats must collapse onto the id already held');
  setWakeLock(false);
  assert.deepEqual(log, ['start->0', 'stop(0)'], 'and it must stop THAT id, not a truthy stand-in');
});

test('createWakeLockToggle releasing what it never took is a no-op', () => {
  const { blocker, log } = fakeBlocker();
  const setWakeLock = createWakeLockToggle(blocker);
  setWakeLock(false);
  setWakeLock(false);
  assert.deepEqual(log, [], 'teardown paths fire on sessions that never asked for a lock');
});

test('createWakeLockToggle can be re-taken after release, with the new id', () => {
  // Reload, then a fresh session: the second blocker gets a different id and must be the one
  // stopped. Tracking the first id forever would leak it.
  const { blocker, log } = fakeBlocker();
  const setWakeLock = createWakeLockToggle(blocker);
  setWakeLock(true);
  setWakeLock(false);
  setWakeLock(true);
  setWakeLock(false);
  assert.deepEqual(log, ['start->0', 'stop(0)', 'start->1', 'stop(1)']);
});

// The payload is stdout from a PowerShell process — a trust boundary of its own kind: the shape
// depends on the shell, the locale and how many processes matched. Its pid then goes straight to
// a WASAPI call that mutes an app for every viewer.
test('parseAudioApps reads the normal multi-app array', () => {
  const json = JSON.stringify([
    { Id: 20688, ProcessName: 'Discord', MainWindowTitle: '@someone - Discord' },
    { Id: 5544, ProcessName: 'Code', MainWindowTitle: 'host.ts - Stream-Share' },
  ]);
  assert.deepEqual(parseAudioApps(json, 999), [
    { pid: 5544, name: 'Code', title: 'host.ts - Stream-Share' },
    { pid: 20688, name: 'Discord', title: '@someone - Discord' }, // sorted by name
  ]);
});

test('parseAudioApps accepts the single-result object ConvertTo-Json emits', () => {
  // PowerShell collapses a one-element pipeline to a bare object. Treating that as "no apps" would
  // silently empty the list on a machine with a single windowed app.
  const json = JSON.stringify({ Id: 42, ProcessName: 'Discord', MainWindowTitle: 'x' });
  assert.deepEqual(parseAudioApps(json, 999), [{ pid: 42, name: 'Discord', title: 'x' }]);
});

test('parseAudioApps drops our own process', () => {
  const json = JSON.stringify([{ Id: 777, ProcessName: 'StreamShare', MainWindowTitle: 'StreamShare' }]);
  assert.deepEqual(parseAudioApps(json, 777), []);
});

test('parseAudioApps survives garbage instead of throwing into the IPC handler', () => {
  assert.deepEqual(parseAudioApps('', 1), []);
  assert.deepEqual(parseAudioApps('not json', 1), []);
  assert.deepEqual(parseAudioApps('null', 1), []);
  assert.deepEqual(parseAudioApps('[]', 1), []);
});

test('parseAudioApps rejects rows that could not name a real process', () => {
  const json = JSON.stringify([
    { Id: '20688', ProcessName: 'StringPid' }, // pid must be a number, not a string
    { Id: 0, ProcessName: 'ZeroPid' },
    { Id: -3, ProcessName: 'NegativePid' },
    { Id: 1.5, ProcessName: 'FloatPid' },
    { Id: 10, ProcessName: '' },
    { Id: 11 },
    null,
    'nope',
    { Id: 12, ProcessName: 'Good' }, // missing title is fine — it becomes ''
  ]);
  assert.deepEqual(parseAudioApps(json, 999), [{ pid: 12, name: 'Good', title: '' }]);
});
import { resolveAppOrigin, wsOrigin, contentSecurityPolicy, isInternalUrl, PROD_ORIGIN } from './config.ts';

test('wsOrigin: https→wss, http→ws, keeps host, no path', () => {
  assert.equal(wsOrigin('https://stream.joanybuclon.com'), 'wss://stream.joanybuclon.com');
  assert.equal(wsOrigin('http://localhost:4321'), 'ws://localhost:4321');
});

test('resolveAppOrigin: env override wins, blank falls back to production', () => {
  assert.equal(resolveAppOrigin({}), PROD_ORIGIN);
  assert.equal(resolveAppOrigin({ SS_APP_ORIGIN: '' }), PROD_ORIGIN);
  assert.equal(resolveAppOrigin({ SS_APP_ORIGIN: '   ' }), PROD_ORIGIN);
  assert.equal(resolveAppOrigin({ SS_APP_ORIGIN: 'http://localhost:4321' }), 'http://localhost:4321');
});

test('contentSecurityPolicy: names the (cross-origin) signaling socket in connect-src', () => {
  const csp = contentSecurityPolicy('https://stream.joanybuclon.com');
  assert.match(csp, /connect-src 'self' wss:\/\/stream\.joanybuclon\.com(?![\w.])/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /media-src 'self' blob:/);
  // dev origin keeps its port and downgrades to ws:
  assert.match(contentSecurityPolicy('http://localhost:4321'), /connect-src 'self' ws:\/\/localhost:4321/);
});

test('isInternalUrl: only app:// is internal, everything else opens externally', () => {
  assert.equal(isInternalUrl('app://bundle/index.html'), true);
  assert.equal(isInternalUrl('app://bundle/download/'), true);
  assert.equal(isInternalUrl('https://stream.joanybuclon.com'), false);
  assert.equal(isInternalUrl('https://evil.example/'), false);
  assert.equal(isInternalUrl('file:///etc/passwd'), false);
  assert.equal(isInternalUrl('not a url'), false);
});

// The real layout of the machine this was developed on: a 2560x1440 HDR primary at the origin and
// a 1920x1080 SDR secondary to its right. Both were verified against the addon's own output.
const DISPLAYS: NativeDisplay[] = [
  { deviceName: String.raw`\\.\DISPLAY1`, hdr: true, sdrWhiteNits: 480, sdrWhiteMeasured: true, maxLuminanceNits: 760, left: 0, top: 0, right: 2560, bottom: 1440 },
  { deviceName: String.raw`\\.\DISPLAY5`, hdr: false, sdrWhiteNits: 80, sdrWhiteMeasured: true, maxLuminanceNits: 270, left: 2560, top: 0, right: 4480, bottom: 1080 },
];

test('nativeDisplayFor: associe par origine physique, pas par ordre', () => {
  const primary = nativeDisplayFor(DISPLAYS, { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 });
  const second = nativeDisplayFor(DISPLAYS, { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
  assert.equal(primary?.deviceName, String.raw`\\.\DISPLAY1`);
  assert.equal(primary?.hdr, true);
  assert.equal(second?.deviceName, String.raw`\\.\DISPLAY5`);
  assert.equal(second?.hdr, false, 'le second écran ne doit pas hériter du HDR du premier');
});

// Le piège du scaling : Electron rend des DIP, DXGI des pixels physiques. Sans la multiplication
// par scaleFactor, un écran à 150 % ne serait jamais retrouvé — et l'app resterait silencieusement
// sur le chemin clampé alors que l'écran est bien en HDR.
test('nativeDisplayFor: convertit les DIP en pixels physiques', () => {
  const scaled = { bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 };
  assert.equal(nativeDisplayFor(DISPLAYS, scaled)?.deviceName, String.raw`\\.\DISPLAY1`);
  // 2560 DIP à 150 % = 3840 physiques : aucune origine ne correspond, et inventer une association
  // serait pire que n'en rendre aucune.
  const nowhere = { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 };
  assert.equal(nativeDisplayFor(DISPLAYS, nowhere), null);
});

// L'angle mort que la multiplication ne peut pas couvrir, et pourquoi `nativeOrigin` passe devant.
// En DPI MIXTE, l'origine DIP d'un écran secondaire est la largeur *mise à l'échelle* de tout ce
// qui est à sa gauche — pas sa position physique. Ici : primaire 2560 physiques à 150 % (donc 1707
// en DIP), secondaire à 100 % posé juste après. Windows le met à x=2560, Electron annonce x=1707,
// et 1707 × 1 = 1707. Aucune correspondance : l'écran est en HDR et part quand même sur le chemin
// clampé, sans une seule erreur nulle part. C'est le mode d'échec que ce fichier existe pour tuer.
test('nativeDisplayFor: nativeOrigin rattrape ce que le DPI mixte casse', () => {
  const mixed = { bounds: { x: 1707, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  assert.equal(nativeDisplayFor(DISPLAYS, mixed), null, 'sans nativeOrigin, l écran est perdu');
  assert.equal(
    nativeDisplayFor(DISPLAYS, { ...mixed, nativeOrigin: { x: 2560, y: 0 } })?.deviceName,
    String.raw`\\.\DISPLAY5`,
  );
  // Et il fait autorité, y compris quand les deux répondent : c'est le rectangle que Chromium a
  // lu dans MONITORINFO, la multiplication n'est qu'un repli.
  const both = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, nativeOrigin: { x: 2560, y: 0 } };
  assert.equal(nativeDisplayFor(DISPLAYS, both)?.deviceName, String.raw`\\.\DISPLAY5`);
});

test('nativeDisplayFor: tolère un pixel d écart, et rend null sans correspondance', () => {
  // 1706.67 DIP x 1.5 = 2560.005 → l arrondi peut tomber à 1 près dans un sens ou dans l autre.
  const rounded = { bounds: { x: 1706.67, y: 0, width: 100, height: 100 }, scaleFactor: 1.5 };
  assert.equal(nativeDisplayFor(DISPLAYS, rounded)?.deviceName, String.raw`\\.\DISPLAY5`);
  assert.equal(nativeDisplayFor([], { bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), null);
  // scaleFactor 0 ne doit pas écraser toutes les origines sur 0 et faire matcher le premier écran.
  assert.equal(nativeDisplayFor(DISPLAYS, { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 0 })?.deviceName, String.raw`\\.\DISPLAY5`);
});

// --- picker listing and the native consent gate ---
//
// Ce que ces tests gardent : le chemin natif ne passe PAS par setDisplayMediaRequestHandler, donc
// `approvedTargetFor` est sa seule porte, et elle lit la table construite par `pickerSources` —
// seul endroit du programme où un id de picker est associé à un nom DXGI (voir son docblock pour
// ce qui se passait quand il y en avait deux).

const img = (tag: string) => ({ toJPEG: () => ({ toString: () => `jpeg-${tag}` }) });
/** L'écran HDR (id Electron 100), l'écran SDR (200), et une fenêtre. */
const RAW: CapturerSource[] = [
  { id: 'screen:0:0', name: 'Screen 1', display_id: '100', thumbnail: img('s1'), appIcon: null },
  { id: 'screen:1:0', name: 'Screen 2', display_id: '200', thumbnail: img('s2'), appIcon: null },
  { id: 'window:12:0', name: 'Discord', display_id: '', thumbnail: img('w'), appIcon: { isEmpty: () => false, toDataURL: () => 'data:icon' } },
];
const PICKER_DISPLAYS: PickerDisplay[] = [
  { id: 100, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
  { id: 200, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
];

test('pickerSources: le HDR est par source, pas par machine', () => {
  const { sources } = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined);
  assert.equal(sources.find((s) => s.id === 'screen:0:0')?.hdr, true);
  // Une machine qui a un écran HDR ne doit pas faire passer son écran SDR par le chemin natif.
  assert.equal(sources.find((s) => s.id === 'screen:1:0')?.hdr, false);
  assert.equal(sources.find((s) => s.id === 'window:12:0')?.hdr, false);
  assert.deepEqual(sources.map((s) => s.kind), ['screen', 'screen', 'window']);
  // Le point du chantier : aucun nom de périphérique ne part vers le renderer.
  assert.equal(sources.some((s) => JSON.stringify(s).includes('DISPLAY')), false);
});

// La table couvre TOUTE source nommable, HDR ou non — et ce n'est pas un relâchement de la porte.
// Elle était limitée au HDR au nom de « pas de porte plus large que la fonctionnalité » ; la
// fonctionnalité est maintenant réellement plus large (une fenêtre choisie sur l'écran SDR puis
// glissée sur l'écran HDR doit devenir approuvable sans re-choisir, et une capture qui redémarre
// après une extinction du HDR aussi). Et la restriction n'a jamais constitué une barrière :
// `setDisplayMediaRequestHandler` donne déjà la vidéo complète de ce que `selectedSourceId` désigne,
// sans condition HDR ni prompt de l'OS. Ce qui borne l'accès, c'est le pick — un seul id, posé par
// `ss:select-source`, et que l'appelant doit renvoyer en écho (`expectId`, main.ts).
test('pickerSources: la table nomme toute source résolue, pas seulement les HDR', () => {
  const { devices } = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined);
  assert.deepEqual(
    [...devices],
    [
      ['screen:0:0', { deviceName: String.raw`\\.\DISPLAY1` }],
      ['screen:1:0', { deviceName: String.raw`\\.\DISPLAY5` }],
    ],
  );
  // Ce que la table ne décide PAS : le chemin natif. L'écran SDR est nommable et reste `hdr: false`,
  // donc le renderer ne le route pas en natif — c'est bien le drapeau qui commande, pas la table.
  const { sources } = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined);
  assert.equal(sources.find((s) => s.id === 'screen:1:0')?.hdr, false);
});

// Le `display_id` d'une fenêtre n'est JAMAIS la source de vérité : il est vide pour toutes les
// fenêtres (mesuré : 0 sur 4), et s'il ne l'était pas il désignerait l'écran, pas la fenêtre — un
// clic lancerait une capture plein écran. Seul le résolveur de handle fait autorité.
test('pickerSources: le display_id d une fenêtre ne lui ouvre pas le chemin natif', () => {
  const sneaky: CapturerSource[] = [
    { id: 'window:12:0', name: 'Discord', display_id: '100', thumbnail: img('w'), appIcon: null },
  ];
  const { sources, devices } = pickerSources(sneaky, PICKER_DISPLAYS, DISPLAYS, undefined);
  assert.equal(sources[0].hdr, false, 'sans résolveur, aucune fenêtre n est HDR');
  assert.equal(devices.size, 0);
});

// Le chantier « partager une app sur un écran HDR ». La fenêtre est reliée à son écran par son
// HANDLE (l addon : MonitorFromWindow), seule chose qui puisse répondre — d où le résolveur injecté,
// qui garde cette fonction pure et testable sans Electron ni addon.
test('pickerSources: une fenêtre sur un écran HDR devient capturable en natif', () => {
  const onHdr = (hwnd: number) => ({ device: hwnd === 12 ? String.raw`\\.\DISPLAY1` : null, pid: 900 });
  const { sources, devices } = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined, onHdr);
  const win = sources.find((s) => s.id === 'window:12:0');
  assert.equal(win?.hdr, true);
  // Le blanc de référence traverse aussi : l oublier ne casse rien visiblement, ça rend juste le
  // tone map faux d un facteur 6.
  assert.equal(win?.sdrWhiteNits, 480);
  assert.equal(win?.sdrWhiteMeasured, true);
  // La cible est le HANDLE, pas un nom d écran : capturer la fenêtre, pas le moniteur sous elle.
  assert.deepEqual(approvedTargetFor({ sources, devices }, 'window:12:0', () => 900), { hwnd: 12, pid: 900 });
  // Et surtout PAS la résolution de l écran : la tuile « Discord » afficherait 2560×1440.
  assert.equal(win?.meta, '');
});

// Windows recycle les handles de fenêtre. La liste est prise à l ouverture du sélecteur ; le temps
// que l utilisateur confirme, la fenêtre cliquée peut avoir disparu et son numéro appartenir à autre
// chose. `IsWindow()` répondrait oui, et on capturerait une fenêtre que personne n a choisie — sans
// prompt de l OS derrière ce chemin pour rattraper. Le pid est ce qui distingue les deux.
test('approvedTargetFor: un handle de fenêtre recyclé est refusé, pas capturé', () => {
  const onHdr = () => ({ device: String.raw`\\.\DISPLAY1`, pid: 900 });
  const listing = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined, onHdr);
  assert.deepEqual(approvedTargetFor(listing, 'window:12:0', () => 900), { hwnd: 12, pid: 900 });
  assert.equal(approvedTargetFor(listing, 'window:12:0', () => 4321), null, 'autre processus = autre fenêtre');
  assert.equal(approvedTargetFor(listing, 'window:12:0', () => null), null, 'la fenêtre a disparu');
  // Un écran ne passe pas par là : un nom DXGI ne se fait pas recycler sous nos pieds.
  assert.deepEqual(approvedTargetFor(listing, 'screen:0:0', () => null), { deviceName: String.raw`\\.\DISPLAY1` });
});

test('pickerSources: une fenêtre dont le pid est introuvable n est pas approuvable', () => {
  // Sans pid, il n y a rien contre quoi revérifier le handle plus tard : mieux vaut pas de chemin
  // natif qu une porte qu on ne peut plus refermer.
  const noPid = () => ({ device: String.raw`\\.\DISPLAY1`, pid: null });
  const { sources, devices } = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined, noPid);
  assert.equal(sources.find((s) => s.id === 'window:12:0')?.hdr, true, 'la tuile reste honnête');
  assert.equal(devices.has('window:12:0'), false);
});

// L'angle mort (b) : une fenêtre est classée au moment du listing. Sur l'écran SDR elle part sur le
// chemin clampé — mais elle doit rester NOMMABLE, sinon rien ne pourra l'approuver quand l'hôte la
// glissera sur l'écran HDR, et le partage resterait délavé jusqu'à ce qu'il repasse par le picker.
test('pickerSources: une fenêtre sur un écran SDR reste clampée, mais reste nommable', () => {
  const onSdr = () => ({ device: String.raw`\\.\DISPLAY5`, pid: 900 }); // apparié, mais pas en HDR
  const { sources, devices } = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined, onSdr);
  assert.equal(sources.find((s) => s.id === 'window:12:0')?.hdr, false, 'le renderer ne la route pas en natif');
  assert.deepEqual(devices.get('window:12:0'), { hwnd: 12, pid: 900 }, 'mais la cible existe pour plus tard');
});

test('pickerSources: un résolveur qui ne connaît pas la fenêtre ne la casse pas', () => {
  // Minimisée, fermée entre le listing et la résolution, ou hors Windows : la tuile reste, sans
  // chemin natif. Perdre la source serait pire que perdre le HDR.
  const { sources, devices } = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined, () => ({ device: null, pid: null }));
  assert.equal(sources.length, 3);
  assert.equal(sources.find((s) => s.id === 'window:12:0')?.hdr, false);
  // Les deux écrans restent nommables ; la fenêtre non résolue, elle, n a aucune cible.
  assert.deepEqual([...devices.keys()], ['screen:0:0', 'screen:1:0']);
});

test('pickerSources: meta en pixels physiques, fenêtre propre exclue, icône vide traitée comme absente', () => {
  const scaled: PickerDisplay[] = [{ id: 100, bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }];
  const raw: CapturerSource[] = [
    RAW[0],
    { id: 'window:9:0', name: 'Empty icon', display_id: '', thumbnail: img('e'), appIcon: { isEmpty: () => true, toDataURL: () => 'data:broken' } },
  ];
  const { sources } = pickerSources(raw, scaled, DISPLAYS, 'screen:0:0'); // notre propre fenêtre
  assert.deepEqual(sources.map((s) => s.id), ['window:9:0'], 'la source propre doit disparaître');
  assert.equal(sources[0].icon, null, 'une NativeImage vide rendrait un <img> cassé');
  assert.equal(sources[0].meta, '', 'une fenêtre n a pas de résolution d écran');
  // L écran à 150 % : le rectangle de l addon donne 2560, pile la résolution inscrite sur le carton.
  // Le calcul en DIP, lui, rend 2561 (1707 × 1,5 = 2560,5) — un écran qui n existe pas.
  assert.equal(pickerSources([RAW[0]], scaled, DISPLAYS, undefined).sources[0].meta, '2560×1440');
  // Sans addon (hors Windows, ou chargement raté), le repli DIP reste le seul recours.
  assert.equal(pickerSources([RAW[0]], scaled, [], undefined).sources[0].meta, '2561×1440');
});

test('pickerSources: une source sans écran correspondant reste listée, sans chemin natif', () => {
  // display_id vide ou inconnu arrive vraiment (Electron le documente), et perdre la tuile serait
  // pire que perdre l étiquette de résolution.
  const orphan: CapturerSource[] = [{ id: 'screen:7:0', name: 'Ghost', display_id: '999', thumbnail: img('g'), appIcon: null }];
  const { sources, devices } = pickerSources(orphan, PICKER_DISPLAYS, DISPLAYS, undefined);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].hdr, false);
  assert.equal(sources[0].sdrWhiteMeasured, false);
  // 0, jamais 80 : la valeur par défaut de scRGB est un nombre parfaitement plausible qui rendrait
  // le tone map faux d'un facteur 6, et `sdrWhiteMeasured: false` est le seul garde-fou.
  assert.equal(sources[0].sdrWhiteNits, 0);
  assert.equal(devices.size, 0);
});

test('approvedTargetFor: seule une source de la DERNIÈRE liste est approuvable', () => {
  const listing = pickerSources(RAW, PICKER_DISPLAYS, DISPLAYS, undefined);
  assert.deepEqual(approvedTargetFor(listing, 'screen:0:0'), { deviceName: String.raw`\\.\DISPLAY1` });
  // L écran SDR est approuvable depuis qu une capture doit pouvoir redémarrer après une extinction
  // du HDR — mais il ne l est que parce qu il était DANS cette liste, et le renderer ne le route
  // pas en natif de lui-même (`hdr: false`).
  assert.deepEqual(approvedTargetFor(listing, 'screen:1:0'), { deviceName: String.raw`\\.\DISPLAY5` });
  // Sans résolveur de handle, une fenêtre n a ni écran ni pid : rien à approuver.
  assert.equal(approvedTargetFor(listing, 'window:12:0'), null);
  // Un id jamais listé — un renderer qui a sauté le picker, ou qui invente un id.
  assert.equal(approvedTargetFor(listing, 'screen:42:0'), null);
  assert.equal(approvedTargetFor(listing, null), null, 'rien de sélectionné n approuve rien');
  // Liste invalidée (écran débranché, page rechargée) : on refuse, ce qui ne coûte que le HDR.
  assert.equal(approvedTargetFor(null, 'screen:0:0'), null);
});

// The renderer's sandbox is OFF (so the HDR addon can run in the preload), which promotes the other
// two flags from Electron defaults to the last thing standing between a hostile SDP and Node. This
// test exists to make a future "just flip contextIsolation to debug something" loud.
test('rendererSecurity: sandbox off, mais isolation et nodeIntegration verrouillés', () => {
  const prefs = rendererSecurity('C:/app/preload.cjs');
  assert.equal(prefs.preload, 'C:/app/preload.cjs');
  assert.equal(prefs.sandbox, false, 'délibéré : l addon HDR tourne dans le preload');
  assert.equal(prefs.contextIsolation, true, 'sans bac à sable, c est ce qui sépare le preload de la page');
  assert.equal(prefs.nodeIntegration, false, 'sinon la page — et notre CSP a unsafe-inline — obtient Node');
});
