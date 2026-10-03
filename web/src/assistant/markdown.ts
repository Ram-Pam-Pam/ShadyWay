// Bezpieczny, minimalny Markdown dla odpowiedzi asystenta: akapity, listy, pogrubienie, kursywa, kod, łamanie linii.
// Parser zwraca drzewo (testowalne bez DOM); renderowanie buduje węzły DOM — nigdy innerHTML z tekstem modelu.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] };

const BULLET = /^\s{0,8}[-*•]\s+(.*)$/;
const NUMBERED = /^\s{0,8}(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;

/** Tylko adresy http(s) stają się odnośnikami; wszystko inne zostaje zwykłym tekstem. */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(value) ? value : null;
}

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v += text;
  else out.push({ t: 'text', v: text });
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/** Znaczniki niedomknięte (np. w trakcie strumieniowania) zostają dosłownym tekstem. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plain = '';
  const flush = (): void => {
    pushText(out, plain);
    plain = '';
  };

  while (i < source.length) {
    const char = source[i];

    if (char === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (char === '[') {
      const match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(source.slice(i));
      if (match) {
        flush();
        const href = safeHref(match[2]);
        const inner = parseInline(match[1]);
        if (href) out.push({ t: 'link', href, c: inner });
        else for (const node of inner) node.t === 'text' ? pushText(out, node.v) : out.push(node);
        i += match[0].length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const double = source[i + 1] === char;
      const marker = double ? char + char : char;
      // Podkreślnik w środku słowa (np. nazwa_pliku) nie jest znacznikiem.
      const opensWord = char !== '_' || !isWordChar(source[i - 1]);
      const afterOpen = source[i + marker.length];
      if (opensWord && afterOpen !== undefined && !/\s/.test(afterOpen)) {
        let end = source.indexOf(marker, i + marker.length);
        // Pojedyncza gwiazdka nie może domknąć się na podwójnej („*a **b** c*”).
        while (end >= 0 && !double && (source[end + 1] === char || source[end - 1] === char)) {
          end = source.indexOf(marker, end + 2);
        }
        const closesWord = end < 0 || char !== '_' || !isWordChar(source[end + marker.length]);
        if (end > i + marker.length && closesWord && !/\s/.test(source[end - 1])) {
          flush();
          const inner = parseInline(source.slice(i + marker.length, end));
          out.push(double ? { t: 'bold', c: inner } : { t: 'em', c: inner });
          i = end + marker.length;
          continue;
        }
      }
      plain += marker;
      i += marker.length;
      continue;
    }

    plain += char;
    i++;
  }
  flush();
  return out;
}

function joinLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ t: 'br' });
    out.push(...parseInline(line));
  });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { t: 'ul' | 'ol'; start: number; items: string[][] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ t: 'p', c: joinLines(paragraph) });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map(joinLines);
      blocks.push(list.t === 'ul' ? { t: 'ul', items } : { t: 'ol', start: list.start, items });
    }
    list = null;
  };

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ t: 'h', c: parseInline(heading[1].replace(/\s+#+$/, '')) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.t !== type) {
        flushList();
        list = { t: type, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push([bullet ? bullet[1] : numbered![2]]);
      continue;
    }
    // Wcięta linia po punkcie listy to jego ciąg dalszy.
    if (list && /^\s{2,}\S/.test(rawLine)) {
      list.items[list.items.length - 1].push(line.trim());
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

function renderInline(nodes: readonly Inline[], parent: Node): void {
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        parent.appendChild(document.createTextNode(node.v));
        break;
      case 'br':
        parent.appendChild(document.createElement('br'));
        break;
      case 'code': {
        const code = document.createElement('code');
        code.textContent = node.v;
        parent.appendChild(code);
        break;
      }
      case 'bold':
      case 'em': {
        const element = document.createElement(node.t === 'bold' ? 'strong' : 'em');
        renderInline(node.c, element);
        parent.appendChild(element);
        break;
      }
      case 'link': {
        const anchor = document.createElement('a');
        const href = safeHref(node.href);
        if (href) {
          anchor.href = href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
        }
        renderInline(node.c, anchor);
        parent.appendChild(anchor);
        break;
      }
    }
  }
}

/** Buduje fragment DOM z tekstu Markdown (wyłącznie createElement / createTextNode). */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    if (block.t === 'p' || block.t === 'h') {
      const element = document.createElement('p');
      if (block.t === 'h') element.className = 'md-heading';
      renderInline(block.c, element);
      fragment.appendChild(element);
      continue;
    }
    const listElement = document.createElement(block.t);
    if (block.t === 'ol' && block.start !== 1) (listElement as HTMLOListElement).start = block.start;
    for (const item of block.items) {
      const li = document.createElement('li');
      renderInline(item, li);
      listElement.appendChild(li);
    }
    fragment.appendChild(listElement);
  }
  return fragment;
}
