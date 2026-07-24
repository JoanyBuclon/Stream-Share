// Tiny typed DOM helpers shared by the app orchestrator and controllers.

/** Get an element by id, typed, throwing if the markup is missing (a wiring bug). */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`stream-share: missing #${id} in the DOM`);
  return node as T;
}

/** Query a required `[data-hook]` descendant, throwing if the template changed (mirrors `el`, so a
 *  markup drift fails with a clear message instead of an opaque null-deref). */
export function hook<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string): T {
  const node = root.querySelector<T>(`[data-hook="${name}"]`);
  if (!node) throw new Error(`stream-share: missing [data-hook="${name}"] in the template`);
  return node;
}

export const show = (node: HTMLElement): void => {
  node.hidden = false;
};
export const hide = (node: HTMLElement): void => {
  node.hidden = true;
};
export const setText = (id: string, text: string): void => {
  el(id).textContent = text;
};

/** Up-to-two-letter avatar initials from a nickname. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
