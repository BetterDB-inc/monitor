/**
 * Parse a raw FT.SEARCH response from iovalkey's client.call().
 *
 * iovalkey returns FT.SEARCH results in the following shape:
 *   [totalCount, key1, [field1, val1, field2, val2, ...], key2, [...], ...]
 *
 * - totalCount is a string (e.g. "2")
 * - Each key is a string
 * - Each field list is a flat string array: [fieldName, value, fieldName, value, ...]
 *
 * Returns an array of { key: string, fields: Record<string, string> }.
 * Returns [] if totalCount is "0" or the response is empty/malformed.
 * Never throws — on any parse error, returns [].
 */
export function parseFtSearchResponse(
  raw: unknown,
): Array<{ key: string; fields: Record<string, string> }> {
  try {
    if (!Array.isArray(raw) || raw.length < 1) {
      return [];
    }

    const totalCount = typeof raw[0] === 'string' ? parseInt(raw[0], 10) : Number(raw[0]);
    if (!totalCount || totalCount <= 0) {
      return [];
    }

    const results: Array<{ key: string; fields: Record<string, string> }> = [];

    let i = 1;
    while (i < raw.length) {
      const key = raw[i];
      if (typeof key !== 'string') {
        i++;
        continue;
      }

      const fieldList = raw[i + 1];
      const fields: Record<string, string> = {};

      if (Array.isArray(fieldList)) {
        const len = fieldList.length - (fieldList.length % 2);
        for (let j = 0; j < len; j += 2) {
          const fieldName = String(fieldList[j]);
          const fieldValue = String(fieldList[j + 1]);
          fields[fieldName] = fieldValue;
        }
        i += 2;
      } else {
        // No field list follows the key (e.g. RETURN 0 mode)
        results.push({ key, fields });
        i++;
        continue;
      }

      results.push({ key, fields });
    }

    return results;
  } catch {
    return [];
  }
}
