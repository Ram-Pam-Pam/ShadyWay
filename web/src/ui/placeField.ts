// Pole wyboru miejsca (start lub cel): wyszukiwarka z podpowiedziami w roli combobox.

import type { GeocodeResult } from '../../../shared/types.ts';
import { errorMessage, geocode, isAbortError } from '../api.ts';
import type { Place } from '../store.ts';
import { debounce, el, queryIn } from '../util.ts';

const MIN_QUERY_LENGTH = 3;
const SEARCH_DELAY_MS = 300;

export interface PlaceFieldOptions {
  /** Kontener .place z polem, przyciskiem czyszczenia i listą podpowiedzi. */
  root: HTMLElement;
  onSelect(place: Place): void;
  onClear(): void;
  /** Pole dostało fokus — kolejne kliknięcie mapy ma ustawić ten punkt. */
  onActivate(): void;
}

export class PlaceField {
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly list: HTMLUListElement;
  private readonly options: PlaceFieldOptions;
  private readonly search = debounce((query: string) => void this.runSearch(query), SEARCH_DELAY_MS);
  private results: GeocodeResult[] = [];
  private activeIndex = -1;
  private request: AbortController | null = null;
  private committedLabel = '';

  constructor(options: PlaceFieldOptions) {
    this.options = options;
    this.root = options.root;
    this.input = queryIn<HTMLInputElement>(this.root, '.place__input');
    this.clearButton = queryIn<HTMLButtonElement>(this.root, '.place__clear');
    this.list = queryIn<HTMLUListElement>(this.root, '.suggestions');

    this.input.addEventListener('focus', () => {
      this.input.select();
      options.onActivate();
    });
    this.input.addEventListener('input', () => this.handleInput());
    this.input.addEventListener('keydown', (event) => this.handleKeydown(event));
    this.input.addEventListener('blur', () => {
      this.close();
      this.input.value = this.committedLabel;
      this.syncClearButton();
    });
    this.clearButton.addEventListener('click', () => {
      this.cancelSearch();
      options.onClear();
      this.input.focus();
    });
    // mousedown zamiast click: wybór musi zadziałać, zanim pole straci fokus i lista się zamknie.
    this.list.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const option = (event.target as Element).closest<HTMLElement>('[data-index]');
      if (option) this.choose(Number(option.dataset.index));
    });
  }

  /** Ustawia zatwierdzone miejsce (lub jego brak) pokazywane w polu. */
  setPlace(place: Place | null): void {
    this.committedLabel = place?.label ?? '';
    if (document.activeElement !== this.input || !this.isOpen()) {
      this.input.value = this.committedLabel;
    }
    this.syncClearButton();
  }

  /** Wyróżnia pole jako cel następnego kliknięcia mapy. */
  setActive(active: boolean): void {
    this.root.classList.toggle('place--active', active);
  }

  private isOpen(): boolean {
    return !this.list.hidden;
  }

  private syncClearButton(): void {
    this.clearButton.hidden = this.input.value === '' && this.committedLabel === '';
  }

  private cancelSearch(): void {
    this.search.cancel();
    this.request?.abort();
    this.request = null;
  }

  private handleInput(): void {
    this.syncClearButton();
    const query = this.input.value.trim();
    this.cancelSearch();
    if (query.length < MIN_QUERY_LENGTH) {
      this.close();
      return;
    }
    this.showMessage('Szukam…');
    this.search(query);
  }

  private async runSearch(query: string): Promise<void> {
    const controller = new AbortController();
    this.request = controller;
    try {
      const results = await geocode(query, controller.signal);
      if (controller.signal.aborted) return;
      this.results = results;
      this.activeIndex = -1;
      if (results.length === 0) this.showMessage('Nie znaleziono takiego miejsca w Krakowie');
      else this.renderResults();
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      this.showMessage(errorMessage(error));
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.isOpen()) event.preventDefault();
      this.cancelSearch();
      this.close();
      this.input.value = this.committedLabel;
      this.syncClearButton();
      return;
    }
    if (!this.isOpen() || this.results.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const count = this.results.length;
      this.setActiveIndex((this.activeIndex + step + count + (this.activeIndex < 0 && step < 0 ? 1 : 0)) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.choose(this.activeIndex >= 0 ? this.activeIndex : 0);
    }
  }

  private choose(index: number): void {
    const result = this.results[index];
    if (!result) return;
    this.cancelSearch();
    this.close();
    this.committedLabel = result.label;
    this.input.value = result.label;
    this.options.onSelect({ lat: result.lat, lon: result.lon, label: result.label });
    this.input.blur();
  }

  private optionId(index: number): string {
    return `${this.list.id}-option-${index}`;
  }

  private setActiveIndex(index: number): void {
    this.activeIndex = index;
    this.list.querySelectorAll<HTMLElement>('[data-index]').forEach((option, i) => {
      const selected = i === index;
      option.setAttribute('aria-selected', String(selected));
      if (selected) option.scrollIntoView({ block: 'nearest' });
    });
    if (index >= 0) this.input.setAttribute('aria-activedescendant', this.optionId(index));
    else this.input.removeAttribute('aria-activedescendant');
  }

  private renderResults(): void {
    const options = this.results.map((result, index) => {
      // Etykieta geokodera to zwykle "nazwa, reszta adresu" — pierwszą część wyróżniamy.
      const [head, ...rest] = result.label.split(', ');
      const option = el(
        'li',
        'suggestions__option',
        el('span', 'suggestions__name', head),
        rest.length > 0 && el('span', 'suggestions__detail', rest.join(', ')),
      );
      option.id = this.optionId(index);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.dataset.index = String(index);
      return option;
    });
    this.list.replaceChildren(...options);
    this.open();
  }

  private showMessage(message: string): void {
    this.results = [];
    this.activeIndex = -1;
    const item = el('li', 'suggestions__message', message);
    item.setAttribute('role', 'presentation');
    this.list.replaceChildren(item);
    this.input.removeAttribute('aria-activedescendant');
    this.open();
  }

  private open(): void {
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  private close(): void {
    this.list.hidden = true;
    this.list.replaceChildren();
    this.results = [];
    this.activeIndex = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
}
