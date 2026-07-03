import { chat, DEFAULT_CHAT_MODEL } from './reader';
import { extractJsonArray } from './json';
import type { Fact } from './facts';

const LINK_MODEL = process.env.LONGMEMEVAL_GRAPH_MODEL ?? DEFAULT_CHAT_MODEL;

// Maps each text to the entity names it mentions, aligned with the input order.
// One call per batch so the per-record LLM cost stays bounded.
export type EntityLinker = (texts: string[]) => Promise<string[][]>;

export interface EntityGraph {
  facts: Fact[];
  factsByEntity: Map<string, number[]>;
  entitiesByFact: string[][];
}

function normalizeEntity(entity: string): string {
  return entity.trim().toLowerCase();
}

export function buildEntityGraph(facts: Fact[], entitiesPerFact: string[][]): EntityGraph {
  const factsByEntity = new Map<string, number[]>();
  const entitiesByFact: string[][] = [];
  for (let i = 0; i < facts.length; i++) {
    const normalized = [...new Set((entitiesPerFact[i] ?? []).map(normalizeEntity))].filter(
      (entity) => {
        return entity !== '';
      },
    );
    entitiesByFact.push(normalized);
    for (const entity of normalized) {
      const indices = factsByEntity.get(entity) ?? [];
      indices.push(i);
      factsByEntity.set(entity, indices);
    }
  }
  return { facts, factsByEntity, entitiesByFact };
}

export interface TraverseOptions {
  // Drop facts whose date is after this bound; dateless facts are kept (they
  // carry no temporal claim to lose against). Mirrors the temporal lever.
  asOf?: string;
  limit?: number;
}

function isValidAsOf(fact: Fact, asOf: string | undefined): boolean {
  if (asOf === undefined || asOf === '' || fact.date === undefined) {
    return true;
  }
  return fact.date <= asOf;
}

// BFS from the seed entities: hop 1 collects facts mentioning a seed, each
// collected fact's entities become the next frontier, and so on up to `hops`.
// Facts are returned in discovery order, deduped, capped at `limit`.
export function traverseGraph(
  graph: EntityGraph,
  seeds: string[],
  hops: number,
  options: TraverseOptions = {},
): Fact[] {
  const visitedEntities = new Set<string>();
  let frontier: string[] = [];
  for (const seed of seeds) {
    const normalized = normalizeEntity(seed);
    if (normalized !== '' && visitedEntities.has(normalized) === false) {
      visitedEntities.add(normalized);
      frontier.push(normalized);
    }
  }

  const collected = new Set<number>();
  const ordered: Fact[] = [];
  for (let hop = 0; hop < hops; hop++) {
    if (frontier.length === 0) {
      break;
    }
    const nextFrontier: string[] = [];
    for (const entity of frontier) {
      for (const index of graph.factsByEntity.get(entity) ?? []) {
        if (collected.has(index)) {
          continue;
        }
        if (isValidAsOf(graph.facts[index], options.asOf) === false) {
          continue;
        }
        collected.add(index);
        ordered.push(graph.facts[index]);
        for (const linked of graph.entitiesByFact[index]) {
          if (visitedEntities.has(linked) === false) {
            visitedEntities.add(linked);
            nextFrontier.push(linked);
          }
        }
      }
    }
    frontier = nextFrontier;
  }

  if (options.limit !== undefined) {
    return ordered.slice(0, options.limit);
  }
  return ordered;
}

export function createMockEntityLinker(): EntityLinker {
  return async (texts) => {
    return texts.map((text) => {
      const matches = text.match(/\b[A-Z][a-z]+\b/g) ?? [];
      return [...new Set(matches.map(normalizeEntity))];
    });
  };
}

export function parseEntityLists(raw: string, expectedLength: number): string[][] {
  const empty = (): string[][] => {
    return Array.from({ length: expectedLength }, () => []);
  };
  // A malformed reply degrades to no entities rather than aborting the run.
  const parsed = extractJsonArray(raw);
  if (parsed === null) {
    return empty();
  }
  const lists: string[][] = [];
  for (let i = 0; i < expectedLength; i++) {
    const row = parsed[i];
    if (Array.isArray(row)) {
      lists.push(
        row.filter((item): item is string => {
          return typeof item === 'string';
        }),
      );
    } else {
      lists.push([]);
    }
  }
  return lists;
}

export function createOpenAIEntityLinker(apiKey: string): EntityLinker {
  const system =
    'For each input text, list the named entities it mentions (people, places, ' +
    'organizations, products). Return ONLY a JSON array with one array of entity ' +
    'name strings per input text, in the same order. Use short canonical names. ' +
    'If a text has no entities, use [].';
  return async (texts) => {
    const user = texts.map((text, i) => `${i + 1}. ${text}`).join('\n');
    const reply = await chat(apiKey, LINK_MODEL, system, user);
    return parseEntityLists(reply, texts.length);
  };
}
