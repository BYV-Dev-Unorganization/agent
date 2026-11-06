export function countCodePoints(text) {
  return Array.from(text).length;
}

export function countUtf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/** Lossless Unicode-aware splitting with character and UTF-8 byte budgets. */
export function splitTextLossless(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  const maxChars = options.maxChars ?? 5000;
  const maxBytes = options.maxBytes ?? 9000;
  const boundaryRatio = options.boundaryRatio ?? 0.72;
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError("maxChars must be positive");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be positive");
  if (boundaryRatio < 0 || boundaryRatio > 1) throw new RangeError("boundaryRatio must be between 0 and 1");
  if (!text.length) return [];

  const points = Array.from(text);
  const chunks = [];
  let start = 0;
  while (start < points.length) {
    let end = start;
    let bytes = 0;
    while (end < points.length && end - start < maxChars) {
      const next = Buffer.byteLength(points[end], "utf8");
      if (bytes + next > maxBytes) break;
      bytes += next;
      end += 1;
    }
    if (end === start) throw new RangeError("Chunk budget cannot fit one Unicode code point");

    if (end < points.length) {
      const floor = start + Math.floor((end - start) * boundaryRatio);
      for (let i = end - 1; i >= floor; i -= 1) {
        if ([" ", "\n", "\t", ".", "!", "?", "。", "！", "？", "；", ";"].includes(points[i])) {
          end = i + 1;
          break;
        }
      }
    }
    chunks.push(points.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

export function packTextGroups(items, options = {}) {
  const maxBytes = options.maxBytes ?? 6500;
  const maxChars = options.maxChars ?? 6500;
  const groups = [];
  let current = [];
  let bytes = 0;
  let chars = 0;

  for (const item of items) {
    const pieces = countUtf8Bytes(item) > maxBytes || countCodePoints(item) > maxChars
      ? splitTextLossless(item, { maxBytes, maxChars })
      : [item];

    for (const piece of pieces) {
      const pieceBytes = countUtf8Bytes(piece);
      const pieceChars = countCodePoints(piece);
      const extraBytes = current.length ? 2 : 0;
      const extraChars = current.length ? 2 : 0;
      if (current.length && (bytes + extraBytes + pieceBytes > maxBytes ||
          chars + extraChars + pieceChars > maxChars)) {
        groups.push(current);
        current = [];
        bytes = 0;
        chars = 0;
      }
      const separatorBytes = current.length ? 2 : 0;
      const separatorChars = current.length ? 2 : 0;
      current.push(piece);
      bytes += separatorBytes + pieceBytes;
      chars += separatorChars + pieceChars;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}
