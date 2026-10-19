/**
 * Speech Text Cleaner
 * Prepares raw AI assistant Markdown content for clean, natural speech synthesis.
 *
 * Rules:
 * - Omits button labels, copy controls, and UI clutter.
 * - Simplifies fenced code blocks into natural audio notices rather than reading syntax symbols.
 * - Unwraps Markdown formatting (headings, lists, bold, italics, links, blockquotes, tables).
 * - Preserves natural punctuation and pauses for human-like auditory flow.
 */

/**
 * Sanitizes markdown tables into readable text sentences.
 * @param {string} tableBlock
 * @returns {string}
 */
function cleanTableForSpeech(tableBlock) {
  const lines = tableBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|'));

  if (lines.length < 2) return '';

  const parseRow = (line) =>
    line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());

  const headers = parseRow(lines[0]);
  const dataRows = lines
    .slice(1)
    .filter((line) => !/^[|\s:-]+$/.test(line))
    .map(parseRow);

  if (dataRows.length === 0) {
    return headers.join(', ') + '.';
  }

  const spokenRows = dataRows.map((row) => {
    const pairs = [];
    for (let i = 0; i < row.length; i++) {
      const header = headers[i] || `Column ${i + 1}`;
      const val = row[i];
      if (val) {
        pairs.push(`${header}: ${val}`);
      }
    }
    return pairs.join(', ');
  });

  return 'Table: ' + spokenRows.join('. ') + '.';
}

/**
 * Main Markdown to Speech Text converter.
 * @param {string} markdown
 * @returns {string} Clean plain text suitable for speech synthesis
 */
export function cleanTextForSpeech(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';

  let text = markdown;

  // 1. Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. Replace fenced code blocks with sensible spoken notices
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang) => {
    const cleanLang = (lang || '').trim();
    if (cleanLang) {
      return `\nCode example in ${cleanLang} omitted from audio.\n`;
    }
    return '\nCode block omitted from audio.\n';
  });

  // 3. Process tables before removing pipes
  text = text.replace(/((?:\|[^\n]+\|\n?)+)/g, (tableMatch) => {
    // Only convert if it looks like a markdown table with separator line
    if (/\|[\s:-]+-\s*\|/.test(tableMatch)) {
      return '\n' + cleanTableForSpeech(tableMatch) + '\n';
    }
    return tableMatch;
  });

  // 4. Inline code: remove backticks but keep the identifier/code text
  text = text.replace(/`([^`]+)`/g, '$1');

  // 5. Images: remove or speak alt text
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `Image: ${alt}. ` : ''));

  // 6. Links: [Label](URL) -> Label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 7. Headings: # Heading -> Heading. (ensure sentence boundary pause)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1. ');

  // 8. Blockquotes: > Quote -> Quote
  text = text.replace(/^>\s*(.+)$/gm, '$1');

  // 9. Unordered lists: - item, * item, + item -> item.
  text = text.replace(/^[\s]*[-*+]\s+(.+)$/gm, '$1. ');

  // 10. Ordered lists: 1. item -> 1, item.
  text = text.replace(/^[\s]*(\d+)\.\s+(.+)$/gm, '$1, $2. ');

  // 11. Bold, italics, strikethrough
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // 12. Horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');

  // 13. Strip raw HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // 14. Clean special formatting punctuation & bullet characters
  text = text.replace(/[•●▪■◆★]/g, '. ');

  // 15. Fix multiple punctuation marks and spaces
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/([.!?])\s*([.!?])/g, '$1');
  text = text.replace(/\s+/g, ' ');

  // 16. Ensure spacing after sentence terminators
  text = text.replace(/([.!?])([A-Za-z0-9])/g, '$1 $2');

  return text.trim();
}

/**
 * Splits text into sentence/phrase chunks (~180 chars) to prevent Chromium
 * speech synthesis 15-second cutoff timeouts.
 *
 * @param {string} text
 * @param {number} [maxChunkLen=180]
 * @returns {string[]}
 */
/**
 * Splits text into sentence and clause chunks (~140 chars) to prevent mobile
 * speech synthesis timeouts and ensure natural, human-like cadence.
 *
 * @param {string} text
 * @param {number} [maxChunkLen=140]
 * @returns {string[]}
 */
export function splitTextIntoSpeechChunks(text, maxChunkLen = 140) {
  if (!text || typeof text !== 'string') return [];

  const clean = text.trim();
  if (!clean) return [];

  // Match sentence fragments ending with sentence punctuation or newline
  const segments = clean.match(/[^.!?\n۔؟]+[.!?\n۔؟]+|[^.!?\n۔؟]+$/g) || [clean];
  const chunks = [];
  let current = '';

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 1 <= maxChunkLen) {
      current += (current ? ' ' : '') + trimmed;
    } else {
      if (current) {
        chunks.push(current);
      }

      if (trimmed.length > maxChunkLen) {
        // Break long segment at natural clause punctuation (commas, colons, semicolons, dashes)
        const subClauses = trimmed.match(/[^,;:—\n]+[,;:—\n]+|[^,;:—\n]+$/g) || [trimmed];
        let sub = '';

        for (const clause of subClauses) {
          const clauseTrimmed = clause.trim();
          if (!clauseTrimmed) continue;

          if (sub.length + clauseTrimmed.length + 1 <= maxChunkLen) {
            sub += (sub ? ' ' : '') + clauseTrimmed;
          } else {
            if (sub) chunks.push(sub);

            if (clauseTrimmed.length > maxChunkLen) {
              // Fallback to word boundaries if an individual clause is extraordinarily long
              const words = clauseTrimmed.split(/\s+/);
              let wordSub = '';
              for (const w of words) {
                if (wordSub.length + w.length + 1 <= maxChunkLen) {
                  wordSub += (wordSub ? ' ' : '') + w;
                } else {
                  if (wordSub) chunks.push(wordSub);
                  wordSub = w;
                }
              }
              sub = wordSub;
            } else {
              sub = clauseTrimmed;
            }
          }
        }
        current = sub;
      } else {
        current = trimmed;
      }
    }
  }

  if (current && current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Aligns a character offset to a clean word boundary within a text chunk,
 * ensuring words and phrases are not sliced in the middle when resuming speech synthesis.
 *
 * @param {string} text - The speech chunk text
 * @param {number} offset - The raw character offset where speech was stopped
 * @returns {number} Clean starting offset aligned to a word boundary
 */
export function getWordBoundaryOffset(text, offset) {
  if (!text || typeof text !== 'string') return 0;
  const len = text.length;
  if (offset <= 0) return 0;
  if (offset >= len) return len;

  let start = offset;

  // If offset lands directly on whitespace, advance to the start of the next word
  if (/\s/.test(text[start])) {
    while (start < len && /\s/.test(text[start])) {
      start++;
    }
    return start;
  }

  // If offset lands in the middle of a word, backtrack to the beginning of that word
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start--;
  }

  return start;
}

