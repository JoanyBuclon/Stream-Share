// Desktop-only source picker: the grid of screens and windows the Electron shell can capture.
// Browsers have their own getDisplayMedia prompt; Windows has none (Electron's useSystemPicker is
// macOS-15+ only), which is why the shell owns this one. See docs/desktop.md.
//
// Self-contained: `pickSource` opens the dialog, wires it, and resolves with the confirmed source
// id (null if dismissed). The caller supplies the actual capture as `share` so the failure message
// can stay inside the picker instead of landing on a panel that isn't on screen.

import { el, hook, initials, setText } from './dom.ts';

/** Case-insensitive substring match on the source name; a blank query matches everything. */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || name.toLowerCase().includes(q);
}

// Element ids are derived from the kind, so the markup and this list can't drift apart.
const KINDS = ['screen', 'window', 'camera'] as const;

/** 1×1 transparent GIF. A camera has no still to show, and an empty `src` renders as a broken
 *  image — the tile falls back to its initials badge, like a window with no app icon. */
const NO_THUMBNAIL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const CAMERA_PREFIX = 'camera:';

/** The deviceId behind a `camera:<id>` source id, or null for anything else. Lets the caller pick
 *  getUserMedia over getDisplayMedia without re-parsing the id format in two places. */
export function cameraDeviceId(sourceId: string): string | null {
  return sourceId.startsWith(CAMERA_PREFIX) ? sourceId.slice(CAMERA_PREFIX.length) : null;
}

/**
 * Video inputs, offered next to the shell's screens and windows.
 *
 * Here for the HDR pilot (cf. docs/desktop.md § HDR): OBS's Virtual Camera performs the WGC scRGB
 * capture and the BT.2390 tone-map that Chromium's own capturer refuses to do, and surfaces the
 * result as an ordinary video input. Because that makes it a getUserMedia track, it also reaches
 * the hardware encoder like any other camera — which is precisely the question a native frame
 * injection path would still have to answer.
 *
 * A web API, so it costs the shell nothing. Labels stay empty until a capture has been granted
 * once in this origin, hence the numbered fallback.
 */
export async function listCameras(): Promise<NativeSource[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({
        id: `${CAMERA_PREFIX}${d.deviceId}`,
        name: d.label || `Camera ${i + 1}`,
        kind: 'camera' as const,
        meta: '',
        // A camera is never the HDR path: whatever it hands us is already tone-mapped by whoever
        // produced it (OBS, in the pilot). Only a screen can be captured natively, so none of the
        // native-capture fields apply.
        hdr: false,
        sdrWhiteNits: 0,
        sdrWhiteMeasured: false,
        thumbnail: NO_THUMBNAIL,
        icon: null,
      }));
  } catch {
    return []; // never let a camera enumeration failure take down the screen/window grid
  }
}

interface Tile {
  source: NativeSource;
  node: HTMLElement;
}

export interface PickOptions {
  /** The host controller's teardown signal — closes the dialog if the session ends under it. */
  signal: AbortSignal;
  /** Source shared right now, preselected on open. */
  currentId: string | null;
  /** Capture the chosen source. Throwing keeps the dialog open with an error.
   *  Receives the source because the caller cannot read it from anywhere else yet: `share` runs
   *  BEFORE pickSource resolves, so the host's own `sourceId` still holds the previous pick. */
  share: (source: NativeSource) => Promise<void>;
  /** The host's reference-white multiplier, so an HDR screen's tile is exposed like its share. */
  sdrCorrection: number;
}

export function pickSource(native: StreamShareNative, opts: PickOptions): Promise<string | null> {
  const modal = el<HTMLDialogElement>('source-modal');
  const search = el<HTMLInputElement>('source-search');
  const confirmBtn = el<HTMLButtonElement>('btn-source-confirm');
  // Scoped to THIS opening: the dialog markup is reused across openings and across host sessions,
  // so its listeners must go with the tiles they were bound to.
  const ac = new AbortController();
  const signal = ac.signal;

  let tiles: Tile[] = [];
  let selected: NativeSource | null = null;
  let confirmed: string | null = null;
  let capturing = false; // getDisplayMedia in flight — the dialog must not vanish under it

  const status = (text: string): void => {
    setText('source-status', text);
    el('source-status').hidden = false;
  };

  // Search filters in place: rebuilding the grid would swap every <img src="data:…"> and force a
  // JPEG re-decode of every thumbnail on each keystroke.
  const filter = (): void => {
    // Derived from KINDS rather than spelled out, so adding a kind cannot leave a counter behind.
    const shown: Record<(typeof KINDS)[number], number> = { screen: 0, window: 0, camera: 0 };
    for (const t of tiles) {
      t.node.hidden = !matchesQuery(t.source.name, search.value);
      if (!t.node.hidden) shown[t.source.kind]++;
    }
    for (const kind of KINDS) {
      setText(`source-count-${kind}`, `${shown[kind]} available`);
      el(`source-group-${kind}`).hidden = shown[kind] === 0;
    }
    // An empty list is not a failed search — say which one it is.
    if (shown.screen + shown.window > 0) el('source-status').hidden = true;
    else status(tiles.length === 0 ? 'nothing to share' : 'no screen or app matches that search');
  };

  const select = (tile: Tile): void => {
    selected = tile.source;
    for (const t of tiles) {
      const active = t === tile;
      t.node.dataset.active = String(active); // drives the border + the check badge, in CSS
      t.node.setAttribute('aria-pressed', String(active));
    }
    const { name, meta } = tile.source;
    setText('source-selection', meta ? `${name} · ${meta}` : name);
    confirmBtn.disabled = false;
  };

  const template = el<HTMLTemplateElement>('tpl-source-tile').content.firstElementChild;
  if (!template) throw new Error('stream-share: empty #tpl-source-tile');

  const build = (source: NativeSource): Tile => {
    const node = template.cloneNode(true) as HTMLElement;
    hook<HTMLImageElement>(node, 'thumb').src = source.thumbnail;
    hook(node, 'name').textContent = source.name;
    hook(node, 'meta').textContent = source.meta;
    // The visible name is truncated and the meta is a separate node: spell the whole thing out
    // rather than let a screen reader get a clipped label.
    node.setAttribute('aria-label', source.meta ? `${source.name}, ${source.meta}` : source.name);
    const badge = hook(node, 'icon');
    if (source.icon) {
      const img = document.createElement('img');
      img.src = source.icon;
      img.alt = '';
      img.className = 'size-[18px]';
      badge.replaceChildren(img);
    } else {
      badge.textContent = initials(source.name); // "Google Chrome" → GC
    }
    const tile: Tile = { source, node };
    node.addEventListener('click', () => select(tile), { signal });
    return tile;
  };

  const load = async (): Promise<void> => {
    try {
      // In parallel: the shell listing costs a ~300-550 ms IPC round trip, enumerateDevices is
      // local. Cameras resolve to [] on failure rather than rejecting, so they can never be the
      // reason the screen and window grids come back empty.
      const [shellSources, cameras] = await Promise.all([native.listSources(opts.sdrCorrection), listCameras()]);
      const sources = [...shellSources, ...cameras];
      // `signal`, not `modal.open`: the dialog element is shared, so `modal.open` answers "is *a*
      // picker open". Dismiss during the ~300-550 ms listing and reopen, and this call would
      // repaint the NEW picker with tiles whose listeners are bound to this dead signal —
      // a full grid where nothing is clickable.
      if (signal.aborted) return;
      tiles = sources.map(build);
      for (const kind of KINDS) {
        el(`source-grid-${kind}`).replaceChildren(...tiles.filter((t) => t.source.kind === kind).map((t) => t.node));
      }
      filter();
      const current = tiles.find((t) => t.source.id === opts.currentId);
      if (current) select(current);
    } catch (err) {
      if (signal.aborted) return;
      console.error('stream-share: listing capture sources failed', err);
      // Deliberately no auto-fallback. The shell would have to pick a source on its own, and
      // silently sharing the whole desktop to someone who opened a picker is a privacy surprise.
      // Reopening the picker retries. The search box goes away with the grid it filters —
      // otherwise the first keystroke would replace this message with "no match".
      search.disabled = true;
      status('could not list sources — close and try again');
    }
  };

  const dismiss = (): void => {
    if (!capturing) modal.close();
  };

  const confirm = async (): Promise<void> => {
    if (!selected || capturing) return;
    capturing = true;
    confirmBtn.disabled = true;
    try {
      // Awaited: main must hold the id before we capture. A camera id fails main's shape check and
      // clears the selection, which is what we want — nothing stale left for getDisplayMedia.
      await native.selectSource(selected.id);
      await opts.share(selected);
    } catch (err) {
      // The source may have closed or be locked by another app. Say it here — the settings hint
      // the browser path writes to is behind this dialog.
      console.error('stream-share: capturing the picked source failed', err);
      capturing = false;
      status('capture failed — try another source');
      confirmBtn.disabled = false;
      return;
    }
    capturing = false;
    confirmed = selected.id;
    modal.close();
  };

  // Reset the reused markup before it becomes visible.
  search.value = '';
  search.disabled = false;
  for (const kind of KINDS) {
    el(`source-grid-${kind}`).replaceChildren();
    el(`source-group-${kind}`).hidden = true; // stale visibility from a previous open
  }
  setText('source-selection', 'no source selected');
  confirmBtn.disabled = true;
  status('loading sources…');

  search.addEventListener('input', filter, { signal });
  confirmBtn.addEventListener('click', () => void confirm(), { signal });
  el('btn-source-close').addEventListener('click', dismiss, { signal });
  modal.addEventListener(
    'click',
    (e) => {
      if (e.target === modal) dismiss(); // the dialog fills the viewport and is its own scrim
    },
    { signal },
  );
  // Escape, natively. Blocked while capturing: the dialog would go display:none with the capture
  // still running, and a failure message would be written where nobody can read it.
  modal.addEventListener(
    'cancel',
    (e) => {
      if (capturing) e.preventDefault();
    },
    { signal },
  );
  // Session torn down with the picker open: a modal <dialog> sits in the top layer, so hiding the
  // host screen wouldn't dismiss it.
  opts.signal.addEventListener('abort', () => modal.close(), { signal });

  return new Promise<string | null>((resolve) => {
    // `close` covers every exit — buttons, scrim, Escape, teardown. Not bound to `signal`: it is
    // what aborts it. `once` is what keeps it from stacking across openings.
    modal.addEventListener(
      'close',
      () => {
        ac.abort();
        // Drop the thumbnails. They are stills of every open window — password manager, mail,
        // banking — and this renderer talks WebRTC to strangers; they have no business outliving
        // the dialog that showed them.
        for (const kind of KINDS) el(`source-grid-${kind}`).replaceChildren();
        tiles = [];
        resolve(confirmed);
      },
      { once: true },
    );
    // showModal() throws on an already-open dialog, and inside this executor that surfaces as an
    // unhandled rejection. Closing first also retires the previous instance cleanly.
    if (modal.open) modal.close();
    modal.showModal(); // not show(): focus trap, Escape and an inert background
    void load();
  });
}
