// Tool search for discovery mode (ADR 012): BM25 over the tools a user may call. Each tool is a
// document of its server slug and tool part (split on _ - and camelCase, weighted NAME_WEIGHT× by
// repetition) plus its sanitised description. A query equal to a tool part or to the full
// qualified name gets a bonus, so `list_orders` beats a tool that only mentions orders in its
// description. Pure and deterministic (ties break on name).
import type { RegisteredTool } from '../core/registry.js';

const K1 = 1.2;
const B = 0.75;
const NAME_WEIGHT = 3;
const EXACT_NAME_BONUS = 5;
/** A query term naming the server (`woo`, `woocommerce` → slug `woo`) favours its tools. */
const SERVER_BONUS = 1.5;

const STOPWORDS = new Set(
  'a an and are as at be by can do for from get how i in is it me my of on or the this to use with what which you your'.split(
    ' ',
  ),
);

/** Lowercase terms: split camelCase, `_`, `-`, punctuation; drop stopwords; naive plural strip. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

export interface SearchHit {
  tool: RegisteredTool;
  score: number;
}

interface Doc {
  tool: RegisteredTool;
  tf: Map<string, number>;
  length: number;
  toolPart: string;
}

export class ToolIndex {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(tools: RegisteredTool[]) {
    this.docs = tools.map((tool) => {
      const toolPart = tool.name.slice(tool.serverSlug.length + 2);
      const nameTerms = tokenize(`${tool.serverSlug} ${toolPart}`);
      const terms = [
        ...Array.from({ length: NAME_WEIGHT }, () => nameTerms).flat(),
        ...tokenize(tool.description),
      ];
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { tool, tf, length: terms.length, toolPart: toolPart.toLowerCase() };
    });
    this.avgLength = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, limit: number): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    const q = query.trim().toLowerCase();
    const n = this.docs.length;
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / this.avgLength));
      }
      if (q && (q === d.tool.name.toLowerCase() || q === d.toolPart)) score += EXACT_NAME_BONUS;
      const slug = d.tool.serverSlug;
      if (score > 0 && terms.some((t) => t === slug || (slug.length >= 3 && t.startsWith(slug)))) {
        score += SERVER_BONUS;
      }
      if (score > 0) hits.push({ tool: d.tool, score });
    }
    hits.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    return hits.slice(0, limit);
  }
}
