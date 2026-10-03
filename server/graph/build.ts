// Budowa grafu pieszego z dróg OSM: węzły w skrzyżowaniach i na końcach dróg, krawędzie = fragmenty dróg.

import type { Graph, GraphEdge, WalkWay } from '../contracts.ts';

function polylineLength(coords: number[]): number {
  let total = 0;
  for (let i = 2; i < coords.length; i += 2) {
    total += Math.hypot(coords[i] - coords[i - 2], coords[i + 1] - coords[i - 1]);
  }
  return total;
}

/** Ile razy każdy węzeł OSM jest używany; końce dróg liczone podwójnie, więc zawsze stają się węzłami grafu. */
function countNodeUsage(ways: WalkWay[]): Map<number, number> {
  const usage = new Map<number, number>();
  for (const way of ways) {
    const n = way.nodeIds.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const weight = i === 0 || i === n - 1 ? 2 : 1;
      usage.set(way.nodeIds[i], (usage.get(way.nodeIds[i]) ?? 0) + weight);
    }
  }
  return usage;
}

function findRoot(parent: Int32Array, node: number): number {
  let root = node;
  while (parent[root] !== root) root = parent[root];
  while (parent[node] !== root) {
    const next = parent[node];
    parent[node] = root;
    node = next;
  }
  return root;
}

/**
 * Buduje graf: węzły = węzły OSM użyte więcej niż raz (przez różne drogi lub wielokrotnie w jednej)
 * oraz końce dróg. Krawędzie zachowują kierunek drogi OSM (ważne dla tagu sidewalk=left/right).
 * W węźle zablokowanym (brama zamknięta dla pieszych) droga jest cięta, a każdy stykający się z nim odcinek
 * dostaje własny węzeł grafu — do bramy da się dojść z obu stron, ale nie da się przez nią przejść.
 * Zostaje tylko największa (wg łącznej długości) spójna składowa.
 * `raisedKerbNodeIds` (v2): węzły z wysokim krawężnikiem — nie zmieniają topologii, ale dla każdej krawędzi
 * zapamiętywana jest ich liczba (patrz raisedKerbsOf), z której korzysta profil „accessible”.
 */
export function buildGraph(
  ways: WalkWay[],
  blockedNodeIds: Iterable<number> = [],
  raisedKerbNodeIds: Iterable<number> = [],
): Graph {
  const usage = countNodeUsage(ways);
  const blocked = new Set(blockedNodeIds);
  const kerbs = new Set(raisedKerbNodeIds);
  /** Krawężnik w węźle wewnętrznym krawędzi liczy się raz; na jej końcu — po połowie dla krawędzi wchodzącej i wychodzącej. */
  const kerbWeight = (way: WalkWay, fromIdx: number, toIdx: number): number => {
    if (kerbs.size === 0) return 0;
    let weight = 0;
    for (let k = fromIdx; k <= toIdx; k++) {
      if (kerbs.has(way.nodeIds[k])) weight += k === fromIdx || k === toIdx ? 0.5 : 1;
    }
    return weight;
  };

  const nodeIndex = new Map<number, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const internNode = (osmId: number, x: number, y: number): number => {
    let index = blocked.has(osmId) ? undefined : nodeIndex.get(osmId);
    if (index === undefined) {
      index = xs.length;
      nodeIndex.set(osmId, index);
      xs.push(x);
      ys.push(y);
    }
    return index;
  };

  const rawEdges: (Omit<GraphEdge, 'id'> & { kerbs: number })[] = [];
  for (const way of ways) {
    const n = way.nodeIds.length;
    if (n < 2) continue;
    let startIdx = 0;
    for (let i = 1; i < n; i++) {
      if (i < n - 1 && (usage.get(way.nodeIds[i]) ?? 0) < 2 && !blocked.has(way.nodeIds[i])) continue;
      const coords = way.coords.slice(startIdx * 2, (i + 1) * 2);
      const from = internNode(way.nodeIds[startIdx], coords[0], coords[1]);
      const to = internNode(way.nodeIds[i], coords[coords.length - 2], coords[coords.length - 1]);
      const lengthM = polylineLength(coords);
      const edgeKerbs = kerbWeight(way, startIdx, i);
      startIdx = i;
      if (from === to && lengthM === 0) continue;
      rawEdges.push({ from, to, coords, lengthM, way, kerbs: edgeKerbs });
    }
  }

  const rawCount = xs.length;
  const parent = new Int32Array(rawCount);
  for (let i = 0; i < rawCount; i++) parent[i] = i;
  for (const edge of rawEdges) {
    const a = findRoot(parent, edge.from);
    const b = findRoot(parent, edge.to);
    if (a !== b) parent[a] = b;
  }

  const componentLength = new Float64Array(rawCount);
  for (const edge of rawEdges) componentLength[findRoot(parent, edge.from)] += edge.lengthM;
  let mainRoot = -1;
  for (let i = 0; i < rawCount; i++) {
    if (parent[i] === i && (mainRoot < 0 || componentLength[i] > componentLength[mainRoot])) mainRoot = i;
  }

  const remap = new Int32Array(rawCount).fill(-1);
  let nodeCount = 0;
  for (let i = 0; i < rawCount; i++) {
    if (findRoot(parent, i) === mainRoot) remap[i] = nodeCount++;
  }

  const nodeX = new Float64Array(nodeCount);
  const nodeY = new Float64Array(nodeCount);
  for (let i = 0; i < rawCount; i++) {
    if (remap[i] >= 0) {
      nodeX[remap[i]] = xs[i];
      nodeY[remap[i]] = ys[i];
    }
  }

  const edges: GraphEdge[] = [];
  const edgeKerbs: number[] = [];
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const { kerbs: kerbCount, ...raw } of rawEdges) {
    const from = remap[raw.from];
    if (from < 0) continue;
    const to = remap[raw.to];
    const id = edges.length;
    edges.push({ ...raw, id, from, to });
    edgeKerbs.push(kerbCount);
    adjacency[from].push(id);
    if (to !== from) adjacency[to].push(id);
  }

  const graph: Graph = { nodeCount, nodeX, nodeY, edges, adjacency };
  if (kerbs.size > 0) raisedKerbs.set(graph, Float32Array.from(edgeKerbs));
  return graph;
}

const raisedKerbs = new WeakMap<Graph, Float32Array>();

/**
 * Liczba wysokich krawężników (kerb=raised) na każdej krawędzi grafu, indeksowana jak graph.edges;
 * undefined, gdy graf zbudowano bez takich węzłów.
 */
export function raisedKerbsOf(graph: Graph): Float32Array | undefined {
  return raisedKerbs.get(graph);
}
