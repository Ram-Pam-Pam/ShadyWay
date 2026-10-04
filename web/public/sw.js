// Service worker aplikacji „Canopy” (pisany ręcznie, bez wtyczek do budowania).
//  - powłoka aplikacji: index.html w trybie stale-while-revalidate, z zapasowym index.html dla nawigacji offline;
//  - /assets/* (pliki Vite z hashem w nazwie, niezmienne): najpierw pamięć, potem sieć;
//  - podkład mapy (kafle, styl, czcionki, ikony z OpenFreeMap): pamięć o ograniczonym rozmiarze;
//  - /api/*: zawsze sieć — nic nie jest zapamiętywane (w tym rozmowy z asystentem); zapytania inne niż GET
//    w ogóle nie są obsługiwane. Ostatnią trasę do pracy offline zapisuje sama strona (localStorage).

const VERSION = 'v1';
const SHELL_CACHE = `cien-shell-${VERSION}`;
const ASSET_CACHE = `cien-assets-${VERSION}`;
const TILE_CACHE = `cien-map-tiles-${VERSION}`;
const MAP_META_CACHE = `cien-map-meta-${VERSION}`;
const KNOWN_CACHES = [SHELL_CACHE, ASSET_CACHE, TILE_CACHE, MAP_META_CACHE];

const SHELL_URLS = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];
const LIMITS = { [ASSET_CACHE]: 40, [TILE_CACHE]: 600, [MAP_META_CACHE]: 120 };
const MAP_HOSTS = ['tiles.openfreemap.org'];
const TILE_PATH = /\/\d+\/\d+\/\d+(\.[a-z0-9]+)?$/i;

/** Usuwa najstarsze wpisy ponad limit (kolejność kluczy = kolejność dodawania). */
async function trim(cacheName) {
  const limit = LIMITS[cacheName];
  if (!limit) return;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

let writes = 0;
async function put(cacheName, request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  // Przycinanie co kilkanaście zapisów — nie przy każdym kaflu.
  if (++writes % 20 === 0) await trim(cacheName);
}

function assetUrlsIn(html) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) urls.add(match[1]);
  return [...urls];
}

async function precache() {
  const shell = await caches.open(SHELL_CACHE);
  await shell.addAll(SHELL_URLS.map((url) => new Request(url, { cache: 'reload' })));
  // Skrypty i style wskazane w index.html (nazwy z hashem zmieniają się przy każdym wydaniu).
  const index = await shell.match('/');
  if (!index) return;
  const assets = await caches.open(ASSET_CACHE);
  await Promise.all(
    assetUrlsIn(await index.text()).map(async (url) => {
      if (await assets.match(url)) return;
      const response = await fetch(url);
      if (response.ok) await assets.put(url, response);
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('cien-') && !KNOWN_CACHES.includes(name)).map((name) => caches.delete(name)));
      await Promise.all(Object.keys(LIMITS).map(trim));
      await self.clients.claim();
    })(),
  );
});

// Strona podaje listę plików /assets/ pobranych przed przejęciem jej przez workera (np. worker mapy).
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'cache-assets' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      for (const raw of data.urls.slice(0, 40)) {
        let url;
        try {
          url = new URL(raw, self.location.origin);
        } catch {
          continue;
        }
        if (url.origin !== self.location.origin || !url.pathname.startsWith('/assets/')) continue;
        if (await cache.match(url.href)) continue;
        try {
          const response = await fetch(url.href);
          if (response.ok) await cache.put(url.href, response);
        } catch {
          // Plik dociągnie się przy następnej wizycie.
        }
      }
      await trim(ASSET_CACHE);
    })(),
  );
});

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  event.waitUntil(put(cacheName, event.request, response.clone()));
  return response;
}

async function staleWhileRevalidate(event, cacheName) {
  const key = event.request;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key);
  const refresh = fetch(event.request).then((response) => {
    event.waitUntil(put(cacheName, key, response.clone()));
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

/** Nawigacja: zapamiętany index.html od razu (odświeżany w tle); offline — także dla nieznanych adresów. */
async function navigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match('/');
  // Odświeżamy zawsze '/', żeby pod tym kluczem nigdy nie znalazło się nic poza index.html.
  const refresh = fetch('/', { cache: 'no-cache' }).then((response) => {
    if (response.ok) event.waitUntil(cache.put('/', response.clone()));
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
    if (request.mode === 'navigate') {
      event.respondWith(navigation(event));
      return;
    }
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith(cacheFirst(event, ASSET_CACHE));
      return;
    }
    if (SHELL_URLS.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
      event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
    }
    return;
  }

  if (MAP_HOSTS.includes(url.hostname)) {
    if (TILE_PATH.test(url.pathname)) event.respondWith(cacheFirst(event, TILE_CACHE));
    else event.respondWith(staleWhileRevalidate(event, MAP_META_CACHE));
  }
});
