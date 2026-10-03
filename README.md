# Cień — piesza nawigacja po Krakowie w cieniu

Aplikacja webowa typu smart city: prowadzi pieszego z punktu A do B po chodnikach i ścieżkach tak, żeby
o wybranej dacie i godzinie jak najmniej iść w słońcu (a zimą — odwrotnie: jak najwięcej). Dla każdego
zapytania zwraca do trzech tras (najkrótsza, zbalansowana, najbardziej zacieniona / najbardziej słoneczna)
z udziałem cienia, czasem przejścia, komfortem cieplnym i wskazówkami krok po kroku. Na szerokich ulicach
z osobnymi chodnikami (np. Aleje Trzech Wieszczów) wybiera tę stronę, która o danej porze jest w cieniu.

## Co nowego w wersji 2

- **Wysokości z LiDAR-u** — budynki, korony drzew i rzeźba terenu z lotniczego skaningu laserowego GUGiK
  (NMT + NMPT, siatka 1 m) zamiast domyślnych wysokości z OSM. Drzewa niezmapowane w OSM też rzucają cień.
- **Sezon bezlistny** — od 1 listopada do 10 kwietnia korony drzew przepuszczają większość światła.
- **Tryb zimowy** — gdy temperatura odczuwalna spada poniżej ok. 12 °C, tryb „Auto" szuka słońca zamiast
  cienia (można też wymusić „Szukaj cienia" / „Szukaj słońca").
- **Profile poruszania się** — „Pieszo", „Wózek / bez schodów" (bez schodów, z karami za złą nawierzchnię
  i wysokie krawężniki) oraz „Senior" (wolniejszy marsz, schody tylko w ostateczności).
- **Światła i schody** — szacowany czas czekania na przejściach jest wliczony w czas trasy; karta trasy
  pokazuje liczbę przejść z sygnalizacją i odcinków schodów.
- **Komfort cieplny** — temperatura odczuwalna w słońcu i w cieniu oraz kategoria obciążenia cieplnego.
- **Punkty chłodu** — woda pitna, fontanny, ławki, parki i wiaty jako warstwa mapy; opcja „Przez punkt
  chłodu" prowadzi trasę obok wody, jeśli nadkłada to niewiele drogi.
- **„Kiedy najlepiej wyjść?"** — porównanie godzin wyjścia w oknie 6 lub 12 h (wykres ocen komfortu).
- **Wskazówki krok po kroku i nawigacja** — lista manewrów po polsku, prowadzenie po GPS z automatycznym
  przeliczaniem po zejściu z trasy, komunikaty głosowe; `?demo=1` w adresie uruchamia symulację marszu.
- **Asystent AI** (opcjonalny) — rozmowa po polsku: „Zaplanuj trasę w cieniu z AGH na Wawel dziś o 15".
  Wymaga klucza Gemini API (patrz niżej); bez klucza reszta aplikacji działa normalnie.
- **PWA** — aplikację można zainstalować; offline pokazuje ostatnio wyznaczoną trasę i obejrzane kafle mapy.

## Uruchomienie

Wymagany Node.js 22+ (projekt rozwijany na Node 24).

```bash
npm install

# tryb deweloperski: API na :3001, frontend (Vite) na http://localhost:5173
npm run dev

# albo jedna aplikacja na jednym porcie: http://localhost:3001
npm run build
npm start
```

### Zmienne środowiskowe

| Zmienna | Znaczenie |
|---|---|
| `PORT` | Port serwera (domyślnie 3001). |
| `HOST` | Adres nasłuchu (domyślnie `localhost`; `HOST=0.0.0.0` udostępnia aplikację w sieci lokalnej). |
| `GEMINI_API_KEY` | Klucz Gemini API (Google AI Studio, aistudio.google.com) — włącza asystenta AI; zamiennie `GOOGLE_API_KEY`. Bez niego `/api/assistant/status` zwraca `available: false`, a interfejs pokazuje informację, że asystent jest niedostępny. |
| `CIEN_AI_MODEL` | Model asystenta (domyślnie `gemini-3.8-flash`); można wskazać inny model Gemini, np. tańszy `gemini-3.5-flash-lite`. |
| `CIEN_LIDAR` | `off` wyłącza dane LiDAR — model cienia korzysta wtedy tylko z OSM (do porównań i diagnostyki). |
| `CIEN_LIDAR_BUDGET_MS` | Ile najdłużej zapytanie o trasę czeka na pobranie brakujących kafli LiDAR (domyślnie 25 000 ms). |

Zmienne można wpisać do pliku `.env` w katalogu projektu (wzór: `.env.example`) — `npm start` i `npm run dev`
wczytują go przy starcie. Plik `.env` jest w `.gitignore`; po zmianie klucza trzeba zrestartować serwer.

### Polecenia

| Polecenie | Co robi |
|---|---|
| `npm run prefetch` | Pobiera z wyprzedzeniem kafle OSM dla centrum Krakowa do `data/osm/` (20 kafli, ok. 1 min). Inny obszar: `npm run prefetch -- <zachód> <południe> <wschód> <północ>`. |
| `npm run prefetch-lidar` | Pobiera kafle LiDAR (NMT + NMPT z GUGiK) dla centrum do `data/lidar/` (20 kafli, ok. 62 MB). Usługa NMPT jest wolna — kilka minut na kafel, całość ponad godzinę; pobieranie można przerwać i wznowić. Te same argumenty obszaru co `prefetch`. |
| `npm run fetch-lst` | Buduje od nowa siatkę temperatury powierzchni `data/lst/krakow_lst.{bin,json}` ze scen Landsat. |
| `npm test` | Testy jednostkowe (vitest, bez dostępu do sieci). |
| `npm run typecheck` | Sprawdzenie typów. |

Bez `prefetch` aplikacja też działa — brakujące kafle OSM pobiera przy pierwszym wyznaczeniu trasy w danej
okolicy (kilka sekund na kafel) i zapisuje na dysku. Zapytanie o trasę czeka na dane mapy najwyżej 40 s;
jeśli to za mało (długa trasa w nowej okolicy, przeciążony Overpass), serwer odpowiada błędem
„spróbuj ponownie za chwilę", a kafle pobierają się dalej w tle — ponowione zapytanie zwykle zastaje je gotowe.
Warstwa cieni na mapie korzysta wyłącznie z kafli już pobranych; gdy dla części widoku ich brakuje, mapa
pokazuje o tym komunikat, a cienie pojawiają się po wyznaczeniu trasy w tej okolicy.

Z danymi LiDAR jest inaczej: pobranie jednego kafla trwa minuty, więc trasa w okolicy bez kafli LiDAR
na dysku jest liczona od razu na wysokościach z OSM (odpowiedź ma wtedy `heightSource: "osm"` albo
`"mixed"`, a interfejs pokazuje „Wysokości: OSM (szacowane)"), kafle dociągają się w tle i kolejne zapytania
korzystają już z LiDAR-u. Poza centrum warto więc uruchomić `npm run prefetch-lidar` dla swojego obszaru.

Po zmianie formatu kafli (stała `TILE_FORMAT_VERSION` w `server/osm/store.ts`) stare pliki w `data/osm/` są
ignorowane i pobierane od nowa — przy pierwszej trasie albo przez `npm run prefetch`.

## Jak to działa

1. **Dane mapy** — budynki, drzewa, zadrzewienia, sieć piesza (z nawierzchnią, sygnalizacją, schodami,
   krawężnikami) i punkty chłodu z OpenStreetMap, pobierane kaflami przez Overpass API (`server/osm`).
2. **LiDAR** — z usług WCS GUGiK pobierane są numeryczny model terenu (NMT) i pokrycia terenu (NMPT);
   różnica daje wysokość obiektów nad gruntem. Budynek dostaje 85. percentyl wysokości w swoim obrysie,
   wszystko powyżej 2,5 m poza obrysami budynków jest traktowane jako roślinność (raster ok. 2 m),
   a NMT daje rzędne terenu (`server/lidar`).
3. **Słońce** — azymut i wysokość słońca liczone dla daty i godziny; sezon bezlistny wg kalendarza
   (`server/geo/sun.ts`).
4. **Cień** — dla punktów próbkowanych co kilka metrów wzdłuż każdego odcinka sieci sprawdzamy, czy promień
   w stronę słońca przecina bryłę budynku, koronę drzewa (marsz po rastrze roślinności; korona przepuszcza
   część światła, zimą większość) albo teren (`server/shade/scene.ts`). Wynik to ekspozycja 0–1; liczona
   jest dla chwili, w której pieszy faktycznie dojdzie do odcinka.
5. **Trasa** — A* po grafie pieszym, koszt = długość × (1 + waga słońca × ekspozycja + waga upału × LST)
   × kara za rodzaj drogi, plus czas czekania na przejściach (`server/graph`). W trybie zimowym ekspozycja
   jest odwracana (karany jest cień). Waga słońca jest skalowana pogodą (zachmurzenie, promieniowanie
   bezpośrednie) i wysokością słońca; w nocy zwracana jest tylko trasa najkrótsza. Trasy zacienione mają
   limit wydłużenia względem trasy „Najkrótsza": 1,35× (zbalansowana) i 2× (najbardziej zacieniona).
   Punkty wyznaczające trasę mogą być oddalone najwyżej o 8 km w linii prostej.
6. **Strona ulicy** — osobno zmapowane chodniki po obu stronach jezdni są osobnymi krawędziami grafu, więc
   wybór strony wynika wprost z ich ekspozycji i z położenia przejść dla pieszych. Dla ulic bez osobnych
   chodników ekspozycja liczona jest dla obu krawędzi jezdni i wskazywana jest zalecana strona.
7. **Bramy** — węzły dróg z barierą zamkniętą dla pieszych przerywają graf: trasa nie prowadzi przez
   prywatne i zamknięte bramy.
8. **Warstwa cieni** — wielokąty cieni liczone są kaflami ok. 360 m na stałej siatce i zapamiętywane.
   Cienie budynków to rzuty obrysów, cienie drzew i terenu to zwektoryzowana maska rastrowa (komórki 2,5 m).
   Jedno zapytanie obejmuje najwyżej ok. 4 km².
9. **Asystent AI** — model Gemini (Google) z narzędziami (geokodowanie, plan trasy, najlepsza godzina, punkty chłodu,
   pogoda), które wywołują tę samą logikę co API (`server/service.ts`); odpowiedź płynie strumieniem SSE,
   a gotowy plan interfejs stosuje na mapie (`server/ai`).

### Ograniczenia

- **LiDAR jest pobrany z wyprzedzeniem tylko dla centrum** (20 kafli); poza nim pierwsza trasa liczy się na
  wysokościach z OSM, a kafel dociąga się w tle przez kilka minut. Data nalotu nie jest znana aplikacji —
  budynki nowsze niż skan mają wysokość z OSM lub zaniżoną, wycięte drzewa nadal „rzucają cień".
- **Jedna wysokość na obrys budynku** — wieże kościołów wychodzą za nisko (np. Kościół Mariacki ok. 38 m
  zamiast ok. 80 m), chyba że OSM ma osobne obrysy `building:part`. Ok. 10% budynków zostaje przy
  wysokości z OSM (za mało komórek rastra, wynik poza zakresem 2–150 m).
- **„Roślinność" to wszystko powyżej 2,5 m poza obrysami budynków** — także wiadukty, mury, niezmapowane
  obiekty i wysokie pojazdy z dnia nalotu. Raster nie odróżnia drzew iglastych, więc zimą wszystkie korony
  są traktowane jak bezlistne.
- **Warstwa cieni drzew jest przybliżeniem** modelu używanego do tras: na 3000 losowych punktów przy Plantach
  wielokąty zgadzały się z dokładnym modelem w 94,8%. Cień budynku na pochyłym terenie jest w warstwie
  przybliżony; cień rzeźby terenu jest rysowany jak cień budynku.
- Dziedzińce zmapowane jako pierścienie `inner` są pod gołym niebem; punkt drogi leżący w obrysie budynku
  to pełny cień (przejście, brama).
- **Światła** — czas czekania to stałe wartości oczekiwane (25 s na przejście z sygnalizacją, 5 s na
  pozostałe przejścia), bez znajomości programów sygnalizacji; zależy od tego, czy OSM ma oznaczoną sygnalizację.
- **Profil „Wózek"** opiera się na tagach OSM, które w Krakowie są rzadkie (`wheelchair` ma ok. 1% dróg,
  nachylenie `incline` w procentach — pojedyncze drogi; w centrum oznaczono 155 wysokich krawężników).
  Brak tagu nie oznacza braku przeszkody. Nachylenia nie są jeszcze liczone z modelu terenu.
- **Wskazówki krok po kroku** często nie podają nazwy ulicy, bo osobno zmapowane chodniki nie mają nazw
  w OSM („Skręć w lewo na chodnik").
- **Kurtyny wodne** nie są zmapowane w OSM w Krakowie — w danych centrum nie ma ani jednej.
- **Temperatura odczuwalna** to przybliżenie na podstawie danych pogodowych dla całego miasta, nie pomiar
  na ulicy. LST z Landsata ma rozdzielczość ok. 100 m i pochodzi z letnich przedpołudni (w trybie zimowym
  nie jest pokazywana).
- **„Kiedy wyjść?"** ocenia trasę zbalansowaną co 30 min; tryb „Auto" jest rozstrzygany raz, dla początku okna.
- **Nawigacja** w przeglądarce zależy od GPS telefonu; komunikaty głosowe i blokada wygaszania ekranu
  działają tylko w przeglądarkach, które je obsługują. Offline dostępna jest tylko ostatnia trasa.
- **Asystent AI** był testowany automatycznie tylko z atrapą klienta API — ścieżka z prawdziwym modelem
  Gemini wymaga klucza i nie była dotąd uruchamiana ani nie jest pokryta testami w repozytorium. Limit: 20 zapytań na 10 minut na adres IP
  (licznik w pamięci procesu; za serwerem pośredniczącym wszyscy użytkownicy dzielą jeden licznik).
- Pamięć: serwer z wczytanym centrum (OSM + LiDAR + sceny cieni) zajmuje kilkaset MB RAM.
- Tryb „Teraz" podąża za zegarem (co minutę i po powrocie do karty), z dokładnością do 15 minut.

## Prywatność

- **Asystent AI**: treść rozmowy z asystentem oraz kontekst planowania (punkty startu i celu, wybrana
  godzina, preferencje, a jeśli udostępniono lokalizację — także pozycja GPS) są wysyłane przez serwer
  aplikacji do Gemini API firmy Google w celu wygenerowania odpowiedzi. Nie wpisuj tam danych,
  których nie chcesz przekazywać. Aplikacja nie zapisuje rozmów na serwerze; przechowywanie i wykorzystanie
  danych po stronie Google zależy od warunków Gemini API i rodzaju konta, do którego należy klucz (warunki
  darmowego i płatnego poziomu różnią się — sprawdź aktualne zasady Google). Bez klucza `GEMINI_API_KEY` asystent jest wyłączony i nic nie jest wysyłane.
- Pozostałe funkcje: zapytania o adresy trafiają do geokodera (Photon / Nominatim), o pogodę — do
  Open-Meteo (tylko godzina, bez pozycji użytkownika), podkład mapy pobiera przeglądarka z OpenFreeMap.
  Preferencje i ostatnia trasa są zapisywane wyłącznie w przeglądarce (localStorage).

## Źródła danych i licencje

| Dane | Źródło | Licencja / warunki |
|---|---|---|
| Budynki, drzewa, sieć piesza, punkty chłodu | © autorzy OpenStreetMap, przez Overpass API | ODbL 1.0 |
| Wysokości budynków i drzew, teren (LiDAR) | Numeryczny Model Terenu i Numeryczny Model Pokrycia Terenu (siatka 1 m), Główny Urząd Geodezji i Kartografii — usługi WCS geoportal.gov.pl | dane państwowego zasobu geodezyjnego i kartograficznego udostępniane nieodpłatnie do dowolnego wykorzystania (art. 40a ust. 2 pkt 1 Prawa geodezyjnego i kartograficznego); podajemy źródło: © GUGiK |
| Temperatura powierzchni (LST) | Landsat 8/9 Collection 2 Level-2 (USGS), przez Microsoft Planetary Computer | domena publiczna (USGS) |
| Pogoda | Open-Meteo (prognoza i archiwum) | CC BY 4.0 |
| Podkład mapy | OpenFreeMap (dane OpenStreetMap) | ODbL 1.0 |
| Wyszukiwanie adresów | Photon (komoot), zapasowo Nominatim; dane OpenStreetMap | ODbL 1.0 |
| Asystent AI | Gemini API (Google) | wymaga własnego klucza; darmowy poziom z limitami albo płatność według zużycia |

Atrybucja źródeł (w tym GUGiK) jest widoczna na mapie. Usługi zewnętrzne poza Gemini API są publiczne
i darmowe — prosimy korzystać z nich z umiarem (aplikacja zapisuje pobrane dane lokalnie i ogranicza liczbę
zapytań; usługa NMPT GUGiK jest odpytywana najwyżej dwoma zapytaniami naraz).

## API (skrót)

Pełny kontrakt: `shared/types.ts`.

| Endpoint | Opis |
|---|---|
| `POST /api/route` | Trasy A → B; opcjonalnie `mobility`, `comfort`, `viaCoolSpot`. Odpowiedź zawiera m.in. `steps`, `waitS`, `thermal`, `heightSource`, `leafOff`. |
| `POST /api/departure` | Porównanie godzin wyjścia w oknie czasu. |
| `GET /api/coolspots?bbox=&time=&kinds=` | Punkty chłodu w oknie mapy (maks. 500), z `time` także informacja o cieniu. |
| `GET /api/shadows?bbox=&time=` | Wielokąty cieni (GeoJSON). |
| `GET /api/assistant/status`, `POST /api/assistant` | Asystent AI (strumień SSE). |
| `GET /api/sun`, `/api/weather`, `/api/geocode`, `/api/reverse`, `/api/heat/*`, `/api/health` | Jak w wersji 1. |

## Struktura

```
shared/types.ts     kontrakt HTTP API (wspólny dla serwera i frontendu)
server/index.ts     serwer Fastify: /api/* oraz zbudowany frontend z dist/
server/service.ts   logika endpointów (wspólna dla HTTP i asystenta AI)
server/validate.ts  walidacja parametrów zapytań
server/osm          pobieranie i parsowanie OSM, cache kafli
server/lidar        klient WCS GUGiK, rastry wysokości, cache kafli LiDAR
server/shade        model cienia, kafle warstwy cieni
server/graph        graf pieszy, trasy, wskazówki, komfort cieplny, godzina wyjścia
server/ai           asystent AI (Gemini API, narzędzia, SSE)
server/heat         siatka LST i nakładka PNG
server/weather      pogoda (Open-Meteo)
web/                frontend (Vite + MapLibre GL): planowanie, nawigacja, asystent, PWA
tests/              testy jednostkowe
```
