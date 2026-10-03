// Drobne narzędzia DOM i sterowania czasem wywołań.

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A): void => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
  debounced.cancel = (): void => clearTimeout(timer);
  return debounced;
}

/** Zwraca element o danym id albo rzuca — brak elementu to błąd w index.html, nie stan aplikacji. */
export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Brak elementu #${id} w dokumencie`);
  return element as T;
}

export function queryIn<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Brak elementu ${selector}`);
  return element;
}

type Child = Node | string | null | false | undefined;

/** Tworzy element z klasą i dziećmi (tekst jest wstawiany bezpiecznie jako węzły tekstowe). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    element.append(child);
  }
  return element;
}
