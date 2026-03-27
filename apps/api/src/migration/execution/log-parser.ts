export interface ParsedLogLine {
  keysTransferred: number | null;
  bytesTransferred: number | null;
  progress: number | null; // 0–100
}

const NULL_RESULT: ParsedLogLine = { keysTransferred: null, bytesTransferred: null, progress: null };

export function parseLogLine(line: string): ParsedLogLine {
  // Strategy 1: Try JSON parse
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj !== null) {
      const scanned =
        obj?.counts?.scanned ??
        obj?.key_counts?.scanned ??
        obj?.scanned ??
        null;
      const total =
        obj?.counts?.total ??
        obj?.key_counts?.total ??
        obj?.total ??
        null;
      const bytes =
        obj?.bytes ??
        obj?.bytes_transferred ??
        null;

      const keysTransferred = typeof scanned === 'number' ? scanned : null;
      const bytesTransferred = typeof bytes === 'number' ? bytes : null;
      let progress: number | null = null;

      if (typeof scanned === 'number' && typeof total === 'number' && total > 0) {
        progress = Math.min(100, Math.round((scanned / total) * 100));
      }

      if (keysTransferred !== null || bytesTransferred !== null || progress !== null) {
        return { keysTransferred, bytesTransferred, progress };
      }
    }
  } catch {
    // Not JSON — fall through to regex
  }

  // Strategy 2: Regex patterns
  const result: ParsedLogLine = { keysTransferred: null, bytesTransferred: null, progress: null };

  const scannedMatch = line.match(/scanned[=: ]+(\d+)/i);
  if (scannedMatch) {
    result.keysTransferred = parseInt(scannedMatch[1], 10);
  }

  const totalMatch = line.match(/total[=: ]+(\d+)/i);
  if (totalMatch && result.keysTransferred !== null) {
    const total = parseInt(totalMatch[1], 10);
    if (total > 0) {
      result.progress = Math.min(100, Math.round((result.keysTransferred / total) * 100));
    }
  }

  const percentMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percentMatch && result.progress === null) {
    result.progress = Math.min(100, Math.round(parseFloat(percentMatch[1])));
  }

  if (result.keysTransferred !== null || result.bytesTransferred !== null || result.progress !== null) {
    return result;
  }

  return NULL_RESULT;
}
