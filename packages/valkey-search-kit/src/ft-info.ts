/**
 * Extract the vector field dimension from a raw FT.INFO reply.
 *
 * Handles both reply shapes across Valkey Search versions:
 * - flat attribute pairs with a 'DIM' key
 * - Valkey Search 1.2, which nests dimension inside an 'index' sub-array
 *   under a 'dimensions' key
 *
 * Returns 0 if no vector field with a positive dimension is found.
 */
export function parseDimensionFromInfo(info: unknown[]): number {
  for (let i = 0; i < info.length - 1; i += 2) {
    const key = String(info[i]);
    if (key !== 'attributes' && key !== 'fields') {
      continue;
    }

    const attributes = info[i + 1];
    if (!Array.isArray(attributes)) {
      continue;
    }

    for (const attr of attributes) {
      if (!Array.isArray(attr)) {
        continue;
      }

      let isVector = false;
      let dim = 0;

      for (let j = 0; j < attr.length - 1; j++) {
        const attrKey = String(attr[j]);
        if (attrKey === 'type' && String(attr[j + 1]) === 'VECTOR') {
          isVector = true;
        }
        if (attrKey.toLowerCase() === 'dim') {
          dim = parseInt(String(attr[j + 1]), 10) || 0;
        }
        if (attrKey === 'index' && Array.isArray(attr[j + 1])) {
          const indexArr = attr[j + 1] as unknown[];
          for (let k = 0; k < indexArr.length - 1; k++) {
            if (String(indexArr[k]) === 'dimensions') {
              const d = parseInt(String(indexArr[k + 1]), 10) || 0;
              if (d > 0) {
                dim = d;
              }
            }
          }
        }
      }

      if (isVector && dim > 0) {
        return dim;
      }
    }
  }

  return 0;
}

export interface FtIndexStats {
  numDocs: number;
  indexingState: string;
}

/**
 * Walk the flat key/value pairs of a raw FT.INFO reply and extract
 * num_docs and the indexing state.
 */
export function parseFtInfoStats(info: unknown[]): FtIndexStats {
  let numDocs = 0;
  let indexingState = 'unknown';
  for (let i = 0; i < info.length - 1; i += 2) {
    const key = String(info[i]);
    if (key === 'num_docs') {
      numDocs = parseInt(String(info[i + 1]), 10) || 0;
    } else if (key === 'indexing') {
      indexingState = String(info[i + 1]);
    }
  }
  return { numDocs, indexingState };
}
