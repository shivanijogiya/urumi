import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SPECIFIER = /(?:from|import)\s*\(?\s*'([^']+)'/g;

// Follows relative imports from index.ts and returns every module specifier it sees.
function importGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [join(SRC, entry)];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (graph.has(file)) continue;
    const specifiers = [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((m) => m[1]!);
    graph.set(file, specifiers);
    for (const s of specifiers.filter((s) => s.startsWith('.'))) {
      queue.push(join(dirname(file), s.replace(/\.js$/, '.ts')));
    }
  }
  return graph;
}

it('the root index pulls in no node: modules (the dashboard bundles it)', () => {
  const graph = importGraph('index.ts');
  expect(graph.size).toBeGreaterThan(4);
  for (const [file, specifiers] of graph) {
    expect(
      specifiers.filter((s) => s.startsWith('node:')),
      file,
    ).toEqual([]);
  }
});

it('the check would catch the Node-only db entry point', () => {
  const specifiers = [...importGraph('db.ts').values()].flat();
  expect(specifiers).toContain('node:url');
});
