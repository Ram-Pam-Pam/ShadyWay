import { describe, expect, it } from 'vitest';
import type { Graph, WalkWay } from '../server/contracts.ts';
import { buildGraph, raisedKerbsOf } from '../server/graph/build.ts';

function way(id: number, nodes: [id: number, x: number, y: number][]): WalkWay {
  return {
    id,
    nodeIds: nodes.map((n) => n[0]),
    coords: nodes.flatMap((n) => [n[1], n[2]]),
    kind: 'footway',
    highway: 'footway',
    covered: false,
    sidewalk: 'unknown',
    sideOffsetM: 0,
    penalty: 1,
    speedFactor: 1,
  };
}

function expectConsistent(graph: Graph): void {
  expect(graph.nodeX).toHaveLength(graph.nodeCount);
  expect(graph.nodeY).toHaveLength(graph.nodeCount);
  expect(graph.adjacency).toHaveLength(graph.nodeCount);
  graph.edges.forEach((edge, index) => {
    expect(edge.id).toBe(index);
    expect(graph.adjacency[edge.from]).toContain(index);
    expect(graph.adjacency[edge.to]).toContain(index);
    expect(edge.coords.slice(0, 2)).toEqual([graph.nodeX[edge.from], graph.nodeY[edge.from]]);
    expect(edge.coords.slice(-2)).toEqual([graph.nodeX[edge.to], graph.nodeY[edge.to]]);
  });
  graph.adjacency.forEach((refs, node) => {
    for (const ref of refs) {
      const edge = graph.edges[ref];
      expect(edge.from === node || edge.to === node).toBe(true);
    }
  });
}

describe('buildGraph — bramy zamknięte dla pieszych', () => {
  // Ulica 1–2–3 i ścieżka 2–4–5; węzeł 4 to brama w środku ścieżki, węzeł 2 to skrzyżowanie.
  const ways = [
    way(1, [
      [1, 0, 0],
      [2, 100, 0],
      [3, 200, 0],
    ]),
    way(2, [
      [2, 100, 0],
      [4, 100, 50],
      [5, 100, 300],
    ]),
  ];

  it('bez blokady ścieżka za bramą należy do grafu', () => {
    const graph = buildGraph(ways);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges.reduce((sum, e) => sum + e.lengthM, 0)).toBeCloseTo(500, 9);
  });

  it('zablokowany węzeł w środku drogi rozcina ją i odłącza część za bramą', () => {
    const graph = buildGraph(ways, [4]);
    expectConsistent(graph);
    // Zostaje ulica i dojście do bramy; 250 m za bramą jest osobną składową i odpada.
    expect(graph.edges.reduce((sum, e) => sum + e.lengthM, 0)).toBeCloseTo(250, 9);
    expect(graph.edges.some((e) => e.coords.includes(300))).toBe(false);
  });

  it('zablokowane skrzyżowanie nie łączy żadnej z dróg, które się w nim spotykają', () => {
    const graph = buildGraph(ways, new Set([2]));
    expectConsistent(graph);
    // Największa składowa to sama ścieżka (300 m); obie połówki ulicy są od niej odcięte.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].lengthM).toBeCloseTo(300, 9);
  });
});

describe('buildGraph', () => {
  it('tnie drogi w węzłach współdzielonych i zachowuje geometrię pośrednią', () => {
    const graph = buildGraph([
      way(1, [
        [1, 0, 0],
        [2, 50, 0],
        [3, 100, 0],
        [4, 150, 10],
        [5, 200, 0],
      ]),
      way(2, [
        [6, 100, -80],
        [3, 100, 0],
        [7, 100, 80],
      ]),
    ]);

    expectConsistent(graph);
    // Węzły: końce obu dróg (4) + skrzyżowanie (3); węzły 2 i 4 są tylko punktami geometrii.
    expect(graph.nodeCount).toBe(5);
    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.map((e) => e.lengthM).sort((a, b) => a - b)).toEqual([
      80,
      80,
      100,
      2 * Math.hypot(50, 10),
    ]);
    const west = graph.edges.find((e) => e.way.id === 1 && e.coords[0] === 0);
    expect(west?.coords).toEqual([0, 0, 50, 0, 100, 0]);
    const junction = graph.adjacency.find((refs) => refs.length === 4);
    expect(junction).toBeDefined();
  });

  it('łączy drogi stykające się końcami i tnie drogę, w której środek wchodzi koniec innej', () => {
    const graph = buildGraph([
      way(1, [
        [1, 0, 0],
        [2, 100, 0],
        [3, 200, 0],
      ]),
      way(2, [
        [2, 100, 0],
        [4, 100, 100],
      ]),
    ]);
    expectConsistent(graph);
    expect(graph.nodeCount).toBe(4);
    expect(graph.edges).toHaveLength(3);
  });

  it('traktuje węzeł użyty dwukrotnie w tej samej drodze jako węzeł grafu', () => {
    // Droga zamknięta w pętlę z "ogonkiem": węzeł 2 występuje dwa razy.
    const graph = buildGraph([
      way(1, [
        [1, 0, 0],
        [2, 100, 0],
        [3, 150, 50],
        [4, 100, 100],
        [2, 100, 0],
      ]),
    ]);
    expectConsistent(graph);
    expect(graph.nodeCount).toBe(2);
    expect(graph.edges).toHaveLength(2);
    const loop = graph.edges.find((e) => e.from === e.to);
    expect(loop?.coords).toEqual([100, 0, 150, 50, 100, 100, 100, 0]);
    expect(graph.adjacency[loop!.from].filter((ref) => ref === loop!.id)).toHaveLength(1);
  });

  it('zostawia tylko największą spójną składową i przenumerowuje węzły', () => {
    const graph = buildGraph([
      // wyspa (pierwsza w danych, więc dostaje najniższe surowe indeksy)
      way(10, [
        [100, 5000, 5000],
        [101, 5030, 5000],
      ]),
      way(1, [
        [1, 0, 0],
        [2, 100, 0],
      ]),
      way(2, [
        [2, 100, 0],
        [3, 100, 100],
      ]),
      // druga wyspa
      way(11, [
        [200, -900, 0],
        [201, -900, 40],
        [202, -900, 90],
      ]),
    ]);
    expectConsistent(graph);
    expect(graph.nodeCount).toBe(3);
    expect(graph.edges.map((e) => e.way.id).sort()).toEqual([1, 2]);
    expect(Math.max(...graph.nodeX)).toBe(100);
  });

  it('pomija drogi zdegenerowane i zwraca pusty graf dla pustych danych', () => {
    expect(buildGraph([]).nodeCount).toBe(0);
    const graph = buildGraph([way(1, [[1, 0, 0]])]);
    expect(graph.nodeCount).toBe(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('buduje graf ze ~150 tys. węzłów dróg wyraźnie poniżej sekundy', () => {
    // Siatka 120×120 skrzyżowań; każda ulica to jedna droga z 4 punktami pośrednimi między skrzyżowaniami.
    const size = 120;
    const sub = 5;
    const span = (size - 1) * sub + 1;
    const nodeId = (ix: number, iy: number): number => ix * 100_000 + iy;
    const ways: WalkWay[] = [];
    for (let line = 0; line < size; line++) {
      const horizontal: [number, number, number][] = [];
      const vertical: [number, number, number][] = [];
      for (let k = 0; k < span; k++) {
        horizontal.push([nodeId(k, line * sub), k * 10, line * sub * 10]);
        vertical.push([nodeId(line * sub, k), line * sub * 10, k * 10]);
      }
      ways.push(way(line, horizontal), way(1000 + line, vertical));
    }
    const wayNodes = ways.reduce((sum, w) => sum + w.nodeIds.length, 0);
    expect(wayNodes).toBeGreaterThan(140_000);

    const started = performance.now();
    const graph = buildGraph(ways);
    const elapsedMs = performance.now() - started;

    expect(graph.nodeCount).toBe(size * size);
    expect(graph.edges).toHaveLength(2 * size * (size - 1));
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('buildGraph — wysokie krawężniki (v2)', () => {
  // Ulica 1–2–3–4 (węzły 2 i 3 to punkty pośrednie) i przecznica 5–3–6: węzeł 3 jest skrzyżowaniem.
  const ways = [
    way(1, [
      [1, 0, 0],
      [2, 50, 0],
      [3, 100, 0],
      [4, 200, 0],
    ]),
    way(2, [
      [5, 100, -50],
      [3, 100, 0],
      [6, 100, 50],
    ]),
  ];

  it('bez krawężników graf nie niesie dodatkowych danych', () => {
    expect(raisedKerbsOf(buildGraph(ways))).toBeUndefined();
    expect(raisedKerbsOf(buildGraph(ways, [], []))).toBeUndefined();
  });

  it('krawężnik wewnątrz krawędzi liczy się raz, w węźle grafu — po połowie na każdą stykającą się krawędź', () => {
    const graph = buildGraph(ways, [], [2, 3]);
    expectConsistent(graph);
    const kerbs = raisedKerbsOf(graph)!;
    expect(kerbs).toHaveLength(graph.edges.length);
    const west = graph.edges.find((e) => e.way.id === 1 && e.coords[0] === 0)!;
    const east = graph.edges.find((e) => e.way.id === 1 && e.coords[0] === 100)!;
    // Zachodnia część ulicy: węzeł 2 w środku (1) + skrzyżowanie 3 na końcu (0,5).
    expect(kerbs[west.id]).toBeCloseTo(1.5, 6);
    expect(kerbs[east.id]).toBeCloseTo(0.5, 6);
    for (const edge of graph.edges.filter((e) => e.way.id === 2)) expect(kerbs[edge.id]).toBeCloseTo(0.5, 6);
    // Przejście przez skrzyżowanie dowolną parą krawędzi = dokładnie jeden krawężnik.
    expect(kerbs[east.id] + kerbs[graph.edges.find((e) => e.way.id === 2)!.id]).toBeCloseTo(1, 6);
  });

  it('krawężniki nie zmieniają topologii grafu', () => {
    const plain = buildGraph(ways);
    const withKerbs = buildGraph(ways, [], [2]);
    expect(withKerbs.nodeCount).toBe(plain.nodeCount);
    expect(withKerbs.edges.map((e) => e.lengthM)).toEqual(plain.edges.map((e) => e.lengthM));
  });
});
