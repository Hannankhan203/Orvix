/**
 * Orvix Shared Office Binary & Spreadsheet Document Extractors
 * Pure JavaScript extractors compatible with both Node.js and ES2020/Safari 15+ browsers.
 * Supports:
 *  - .xlsx (OpenXML Excel Spreadsheets)
 *  - .xls  (Legacy BIFF5/BIFF8 Excel Spreadsheets inside OLE2 CFBF)
 *  - .doc  (Legacy Word 97-2003 MS-DOC Binary inside OLE2 CFBF)
 *  - .ppt  (Legacy PowerPoint 97-2003 MS-PPT Binary inside OLE2 CFBF)
 */

const MAX_EXTRACTION_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB upload limit
const MAX_XLSX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // Guard against ZIP bombs
const MAX_SPREADSHEET_SHEETS = 50;
const MAX_SPREADSHEET_ROWS_PER_SHEET = 2000;
const MAX_SPREADSHEET_COLS_PER_SHEET = 64;
const MAX_PPT_RECORD_DEPTH = 48;
const MAX_DOC_PIECES = 200_000;

const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

// Windows-1252 lookup for bytes 0x80..0x9F (universal fallback if runtime lacks windows-1252 TextDecoder)
const CP1252_HIGH_MAP = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178
];

let cachedCp1252Decoder = null;
let cachedUtf16LeDecoder = null;

function toUint8Array(input) {
  if (!input) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(0);
}

function hasOle2Signature(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== OLE2_SIGNATURE[i]) return false;
  }
  return true;
}

function hasZipSignature(bytes) {
  return Boolean(
    bytes &&
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

function hasRawBiffBofSignature(bytes) {
  if (!bytes || bytes.length < 8) return false;
  // Legacy standalone BIFF2/3/4/5/8 BOF: record ID low byte 0x09, high byte 0x00|0x02|0x04|0x08
  return (
    bytes[0] === 0x09 &&
    (bytes[1] === 0x00 || bytes[1] === 0x02 || bytes[1] === 0x04 || bytes[1] === 0x08)
  );
}

function decodeCp1252(bytes) {
  if (!bytes || bytes.length === 0) return '';
  if (typeof TextDecoder !== 'undefined') {
    try {
      if (!cachedCp1252Decoder) {
        cachedCp1252Decoder = new TextDecoder('windows-1252');
      }
      return cachedCp1252Decoder.decode(bytes);
    } catch (_) {}
  }
  const chunks = [];
  let current = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const code = b >= 0x80 && b <= 0x9f ? CP1252_HIGH_MAP[b - 0x80] : b;
    current += String.fromCharCode(code);
    if (current.length >= 4096) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks.join('');
}

function decodeUtf16Le(bytes) {
  if (!bytes || bytes.length < 2) return '';
  const evenLen = bytes.length - (bytes.length % 2);
  const viewBytes = evenLen === bytes.length ? bytes : bytes.subarray(0, evenLen);
  if (typeof TextDecoder !== 'undefined') {
    try {
      if (!cachedUtf16LeDecoder) {
        cachedUtf16LeDecoder = new TextDecoder('utf-16le');
      }
      return cachedUtf16LeDecoder.decode(viewBytes);
    } catch (_) {}
  }
  const dv = new DataView(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength);
  const chunks = [];
  let current = '';
  for (let i = 0; i < evenLen; i += 2) {
    current += String.fromCharCode(dv.getUint16(i, true));
    if (current.length >= 4096) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks.join('');
}

function buildMarkdownTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const maxCols = Math.max(...rows.map((r) => r.length), 0);
  if (maxCols === 0) return '';

  const sanitizedRows = rows.map((row) =>
    Array.from({ length: maxCols }, (_, c) =>
      String(row[c] ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n+/g, '<br>')
        .replace(/\|/g, '\\|')
        .trim()
    )
  );

  const colWidths = new Array(maxCols).fill(3);
  for (const r of sanitizedRows) {
    for (let c = 0; c < maxCols; c++) {
      colWidths[c] = Math.max(colWidths[c], Math.min((r[c] || '').length, 40));
    }
  }

  const header = sanitizedRows[0];
  const dataRows = sanitizedRows.slice(1);
  const headerLine =
    '| ' +
    Array.from({ length: maxCols }, (_, i) => (header[i] || `Col ${i + 1}`).padEnd(colWidths[i])).join(' | ') +
    ' |';
  const dividerLine = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
  const rowLines = dataRows.map(
    (r) => '| ' + Array.from({ length: maxCols }, (_, i) => (r[i] || '').padEnd(colWidths[i])).join(' | ') + ' |'
  );

  return [headerLine, dividerLine, ...rowLines].join('\n');
}

function parseCellAddress(ref) {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  const colLetters = match[1];
  const rowNum = parseInt(match[2], 10);
  if (!Number.isFinite(rowNum) || rowNum < 1) return null;
  let colIdx = 0;
  for (let i = 0; i < colLetters.length; i++) {
    colIdx = colIdx * 26 + (colLetters.charCodeAt(i) - 64);
  }
  return { r: rowNum - 1, c: colIdx - 1 };
}

function formatSpreadsheetCellValue(cell) {
  if (!cell || typeof cell !== 'object') return '';
  if (typeof cell.w === 'string' && cell.w.trim().length > 0) {
    return cell.w.trim();
  }
  if (cell.t === 'd' && cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
    const iso = cell.v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').slice(0, 19);
  }
  if (cell.t === 'b') {
    return cell.v ? 'TRUE' : 'FALSE';
  }
  if (cell.t === 'e') {
    if (cell.w) return cell.w;
    if (typeof cell.f === 'string' && cell.f.trim() && (cell.v === undefined || cell.v === null)) {
      return `=${cell.f.trim()}`;
    }
    return '#ERROR';
  }
  if (cell.v !== undefined && cell.v !== null) {
    return String(cell.v);
  }
  if (typeof cell.f === 'string' && cell.f.trim()) {
    return `=${cell.f.trim()}`;
  }
  return '';
}

function biffStreamHasFilePass(streamBytes) {
  if (!streamBytes || streamBytes.length < 4) return false;
  const view = new DataView(streamBytes.buffer, streamBytes.byteOffset, streamBytes.byteLength);
  let pos = 0;
  let iterations = 0;
  while (pos + 4 <= streamBytes.length && iterations < 500_000) {
    iterations++;
    const recId = view.getUint16(pos, true);
    const recLen = view.getUint16(pos + 2, true);
    if (recId === 0x002f) {
      // BIFF FILEPASS record indicates encrypted workbook
      return true;
    }
    // EOF (0x000A) for Workbook globals ends header scan
    if (recId === 0x000a) {
      break;
    }
    if (pos + 4 + recLen > streamBytes.length) {
      break;
    }
    pos += 4 + recLen;
  }
  return false;
}

function getCfbEntryBytes(entry) {
  if (!entry || !entry.content) return new Uint8Array(0);
  if (entry.content instanceof Uint8Array) return entry.content;
  if (Array.isArray(entry.content)) return new Uint8Array(entry.content);
  return toUint8Array(entry.content);
}

function findCfbEntryCaseInsensitive(cfbDoc, targetName) {
  if (!cfbDoc || !Array.isArray(cfbDoc.FileIndex)) return null;
  const lower = targetName.toLowerCase();
  for (const entry of cfbDoc.FileIndex) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (entry.name.toLowerCase() === lower && entry.type === 2) {
      return entry;
    }
  }
  return null;
}

/**
 * Extracts readable worksheets, worksheet names, Markdown tables, and section metadata
 * from .xlsx (OpenXML) and .xls (BIFF5/BIFF8 OLE2) spreadsheets.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer} inputBytes
 * @param {string} ext - '.xlsx' or '.xls'
 * @returns {Promise<Object>}
 */
export async function extractSpreadsheetDocument(inputBytes, ext) {
  const bytes = toUint8Array(inputBytes);
  const normalizedExt = String(ext || '').toLowerCase();
  const label = normalizedExt === '.xls' ? 'XLS' : 'XLSX';

  if (bytes.length === 0) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: `The ${label} spreadsheet file is empty (0 bytes).`
    };
  }

  if (bytes.length > MAX_EXTRACTION_INPUT_BYTES) {
    return {
      status: 'error',
      success: false,
      text: '',
      error: `Spreadsheet exceeds the ${Math.round(MAX_EXTRACTION_INPUT_BYTES / (1024 * 1024))} MB extraction size limit.`
    };
  }

  try {
    const cfbModule = await import('cfb');
    const CFB = cfbModule.default || cfbModule;

    // 1. Validate container signature and detect encrypted files BEFORE calling XLSX.read
    // (Prevents SheetJS from silently treating corrupted/non-spreadsheet blobs as CSV text)
    if (hasOle2Signature(bytes)) {
      let cfbDoc;
      try {
        cfbDoc = CFB.read(bytes, { type: 'array' });
      } catch (cfbErr) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: `Failed to parse ${label} compound container: ${cfbErr?.message || 'Corrupted OLE2 file.'}`
        };
      }

      if (
        findCfbEntryCaseInsensitive(cfbDoc, 'EncryptedPackage') ||
        findCfbEntryCaseInsensitive(cfbDoc, 'EncryptionInfo')
      ) {
        return {
          status: 'encrypted',
          success: false,
          text: '',
          error: `This ${label} spreadsheet is encrypted or password-protected and cannot be read without a password.`
        };
      }

      if (normalizedExt === '.xlsx') {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Invalid XLSX file: expected an OpenXML ZIP workbook, not an unencrypted legacy OLE2 container.'
        };
      }

      const wbEntry =
        findCfbEntryCaseInsensitive(cfbDoc, 'Workbook') ||
        findCfbEntryCaseInsensitive(cfbDoc, 'Book');
      if (!wbEntry) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Invalid XLS spreadsheet: missing Workbook stream inside OLE compound file.'
        };
      }

      const wbStreamBytes = getCfbEntryBytes(wbEntry);
      if (biffStreamHasFilePass(wbStreamBytes)) {
        return {
          status: 'encrypted',
          success: false,
          text: '',
          error: 'This Excel (.xls) workbook is encrypted or password-protected and cannot be read without a password.'
        };
      }
    } else if (normalizedExt === '.xlsx') {
      if (!hasZipSignature(bytes)) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Invalid XLSX file: missing standard OpenXML ZIP container signature.'
        };
      }

      const jszipModule = await import('jszip');
      const JSZip = jszipModule.default || jszipModule;
      let zip;
      try {
        zip = await JSZip.loadAsync(bytes);
      } catch (zipErr) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: `Failed to parse XLSX package: ${zipErr?.message || 'Invalid or corrupted ZIP archive.'}`
        };
      }

      const zipFileNames = Object.keys(zip.files);
      const hasWorkbookXml = zipFileNames.some((n) => n.toLowerCase() === 'xl/workbook.xml');
      if (!hasWorkbookXml) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Invalid XLSX spreadsheet: missing xl/workbook.xml in OpenXML archive.'
        };
      }

      let declaredUncompressedTotal = 0;
      for (const entry of Object.values(zip.files)) {
        const uSize = entry?._data?.uncompressedSize;
        if (typeof uSize === 'number' && Number.isFinite(uSize) && uSize > 0) {
          declaredUncompressedTotal += uSize;
        }
      }
      if (declaredUncompressedTotal > MAX_XLSX_UNCOMPRESSED_BYTES) {
        return {
          status: 'error',
          success: false,
          text: '',
          error: 'XLSX workbook exceeds safe decompression limits and cannot be processed.'
        };
      }
    } else {
      // .xls must be OLE2 CFBF or raw BIFF2/3/4 BOF
      if (hasZipSignature(bytes)) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Invalid XLS file: archive appears to be OpenXML ZIP format rather than legacy binary .xls.'
        };
      }
      if (!hasRawBiffBofSignature(bytes)) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Invalid XLS spreadsheet: missing OLE compound binary or BIFF workbook signature.'
        };
      }
    }

    // 2. Parse workbook using SheetJS (@e965/xlsx)
    const xlsxModule = await import('@e965/xlsx');
    const XLSX = xlsxModule.default || xlsxModule;

    let workbook;
    try {
      workbook = XLSX.read(bytes, {
        type: 'array',
        cellDates: true,
        cellNF: true,
        cellText: true
      });
    } catch (parseErr) {
      const msg = String(parseErr?.message || parseErr || '').toLowerCase();
      if (msg.includes('password') || msg.includes('encrypt') || msg.includes('filepass')) {
        return {
          status: 'encrypted',
          success: false,
          text: '',
          error: `This ${label} workbook is encrypted or password-protected and cannot be read without a password.`
        };
      }
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: `Failed to parse ${label} spreadsheet: ${parseErr?.message || 'Malformed spreadsheet structure.'}`
      };
    }

    const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
    if (sheetNames.length === 0) {
      return {
        status: 'empty',
        success: false,
        text: '',
        sheetCount: 0,
        sheetNames: [],
        warning: `The ${label} workbook contains no worksheets.`
      };
    }

    const sheetsToProcess = sheetNames.slice(0, MAX_SPREADSHEET_SHEETS);
    const sections = [];
    const sheetBlocks = [];
    let totalDataRows = 0;
    let maxWorkbookCols = 0;
    let primaryTable = null;
    let truncationNotes = [];

    if (sheetNames.length > MAX_SPREADSHEET_SHEETS) {
      truncationNotes.push(`Workbook has ${sheetNames.length} worksheets; extracted the first ${MAX_SPREADSHEET_SHEETS}.`);
    }

    for (let sIdx = 0; sIdx < sheetsToProcess.length; sIdx++) {
      const sheetName = sheetsToProcess[sIdx];
      const sheet = workbook.Sheets?.[sheetName];
      if (!sheet || typeof sheet !== 'object') continue;

      // Index only actually populated cells (immune to bloated '!ref' metadata ranges)
      const rowMap = new Map();
      let minCol = Infinity;
      let maxCol = -1;

      for (const key of Object.keys(sheet)) {
        if (!key || key[0] === '!') continue;
        const coord = parseCellAddress(key);
        if (!coord) continue;
        const formatted = formatSpreadsheetCellValue(sheet[key]);
        if (!formatted) continue;

        let colsForRow = rowMap.get(coord.r);
        if (!colsForRow) {
          colsForRow = new Map();
          rowMap.set(coord.r, colsForRow);
        }
        colsForRow.set(coord.c, formatted);
        if (coord.c < minCol) minCol = coord.c;
        if (coord.c > maxCol) maxCol = coord.c;
      }

      if (rowMap.size === 0 || maxCol < minCol) {
        continue;
      }

      const sortedRowIndices = Array.from(rowMap.keys()).sort((a, b) => a - b);
      const boundedRowCount = Math.min(sortedRowIndices.length, MAX_SPREADSHEET_ROWS_PER_SHEET);
      const rawColSpan = maxCol - minCol + 1;
      const boundedColSpan = Math.min(rawColSpan, MAX_SPREADSHEET_COLS_PER_SHEET);

      if (sortedRowIndices.length > MAX_SPREADSHEET_ROWS_PER_SHEET) {
        truncationNotes.push(
          `Sheet "${sheetName}" has ${sortedRowIndices.length} non-empty rows; extracted the first ${MAX_SPREADSHEET_ROWS_PER_SHEET}.`
        );
      }
      if (rawColSpan > MAX_SPREADSHEET_COLS_PER_SHEET) {
        truncationNotes.push(
          `Sheet "${sheetName}" has ${rawColSpan} columns; extracted the first ${MAX_SPREADSHEET_COLS_PER_SHEET}.`
        );
      }

      const rows = [];
      for (let r = 0; r < boundedRowCount; r++) {
        const colsForRow = rowMap.get(sortedRowIndices[r]);
        const rowArr = new Array(boundedColSpan);
        for (let c = 0; c < boundedColSpan; c++) {
          rowArr[c] = colsForRow.get(minCol + c) || '';
        }
        rows.push(rowArr);
      }

      const mdTable = buildMarkdownTable(rows);
      if (!mdTable) continue;

      const sheetHeader = `Sheet ${sIdx + 1}: ${sheetName}`;
      const sheetBody = `Rows: ${rows.length} | Columns: ${boundedColSpan}\n\n${mdTable}`;
      sheetBlocks.push(`### ${sheetHeader}\n${sheetBody}`);

      sections.push({
        heading: sheetHeader,
        level: 2,
        content: sheetBody,
        charCount: sheetBody.length,
        sheetName,
        rowCount: rows.length,
        columnCount: boundedColSpan
      });

      const sheetDataRows = Math.max(0, rows.length - 1);
      totalDataRows += sheetDataRows;
      if (boundedColSpan > maxWorkbookCols) {
        maxWorkbookCols = boundedColSpan;
      }

      if (!primaryTable) {
        primaryTable = {
          headers: rows[0] || [],
          rowCount: sheetDataRows,
          columnCount: boundedColSpan,
          previewRows: rows.slice(1, 11),
          markdownTable: mdTable
        };
      }
    }

    if (sheetBlocks.length === 0) {
      return {
        status: 'empty',
        success: false,
        text: '',
        sheetCount: sheetNames.length,
        sheetNames,
        warning: `The ${label} workbook contains ${sheetNames.length} worksheet(s), but all cells are empty.`
      };
    }

    let fullText = sheetBlocks.join('\n\n');
    if (truncationNotes.length > 0) {
      fullText += `\n\n[Note: ${truncationNotes.join(' ')}]`;
    }

    return {
      status: 'ready',
      success: true,
      text: fullText,
      sections,
      sectionCount: sections.length,
      sheetCount: sheetNames.length,
      sheetNames,
      rowCount: totalDataRows,
      columnCount: maxWorkbookCols,
      table: primaryTable,
      isTruncated: truncationNotes.length > 0,
      warning: truncationNotes.length > 0 ? truncationNotes.join(' ') : undefined
    };
  } catch (err) {
    const msg = String(err?.message || err || '');
    const lower = msg.toLowerCase();
    if (lower.includes('password') || lower.includes('encrypt') || lower.includes('filepass')) {
      return {
        status: 'encrypted',
        success: false,
        text: '',
        error: `This ${label} spreadsheet is encrypted or password-protected and cannot be read without a password.`
      };
    }
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: `Failed to parse ${label} spreadsheet: ${msg || 'Invalid or corrupted Excel structure.'}`
    };
  }
}

function cleanWordFieldCodes(raw) {
  const stack = [];
  let out = '';

  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x13) {
      // Field begin
      stack.push({ inResult: false, rawFallback: '' });
      continue;
    }
    if (code === 0x14) {
      // Field separator -> visible display result follows
      if (stack.length > 0) {
        stack[stack.length - 1].inResult = true;
      }
      continue;
    }
    if (code === 0x15) {
      // Field end
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    if (stack.length === 0) {
      out += raw[i];
    } else if (stack.every((frame) => frame.inResult)) {
      out += raw[i];
    } else {
      stack[stack.length - 1].rawFallback += raw[i];
    }
  }

  // If a malformed file has an unclosed 0x13 without a matching 0x15, preserve trailing text
  if (stack.length > 0) {
    for (const frame of stack) {
      if (frame.rawFallback) {
        out += frame.rawFallback;
      }
    }
  }
  return out;
}

function formatWordBinaryTextStream(rawText) {
  if (!rawText) return '';
  const withoutFields = cleanWordFieldCodes(rawText);

  // Split by paragraph marks (\r) and form feeds (\x0C) while retaining \x07 table cell marks
  const normalized = withoutFields.replace(/\r\n/g, '\r').replace(/\x0b/g, '\n');
  const rawParagraphs = normalized.split(/[\r\x0c]/);

  const outputBlocks = [];
  let pendingTableRows = [];

  const flushTable = () => {
    if (pendingTableRows.length > 0) {
      const mdTable = buildMarkdownTable(pendingTableRows);
      if (mdTable) {
        outputBlocks.push(mdTable);
      }
      pendingTableRows = [];
    }
  };

  for (let rawPara of rawParagraphs) {
    // Strip binary Word special chars (embedded objects 0x01, footnote markers 0x02, drawn objects 0x08, etc.)
    // keeping printable text, tabs (\t), newlines (\n), and cell marks (\x07)
    rawPara = rawPara.replace(/[\x00-\x06\x08\x0e-\x1f]/g, '');

    if (rawPara.includes('\x07')) {
      // MS-DOC table rows consist of cells terminated by \x07, followed by row-end \x07 (or split lines)
      const segments = rawPara.split('\x07\x07');
      for (const seg of segments) {
        const cleanSeg = seg.trim();
        if (!cleanSeg && !seg.includes('\x07')) continue;
        const cells = seg
          .split('\x07')
          .map((c) => c.replace(/[ \t]+/g, ' ').trim());
        // Drop trailing empty marker cell caused by row-end delimiter
        while (cells.length > 0 && cells[cells.length - 1] === '') {
          cells.pop();
        }
        if (cells.length > 0 && cells.some((c) => c.length > 0)) {
          pendingTableRows.push(cells);
        }
      }
      continue;
    }

    flushTable();

    const cleanedPara = rawPara
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');

    if (cleanedPara) {
      outputBlocks.push(cleanedPara);
    }
  }

  flushTable();
  return outputBlocks.join('\n\n').trim();
}

function buildDocSectionsFromParagraphs(text) {
  if (!text) return [];
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 0) return [];

  const sections = [];
  let currentHeading = 'Document Body';
  let currentParts = [];

  for (const rawBlock of blocks) {
    // Handle explicit Markdown headings (e.g., "### Footnotes\nFootnote text...")
    const firstNewline = rawBlock.indexOf('\n');
    const firstLine = (firstNewline === -1 ? rawBlock : rawBlock.slice(0, firstNewline)).trim();
    const mdHeadingMatch = /^(#{1,6})\s+(.+)$/.exec(firstLine);
    if (mdHeadingMatch) {
      const tailContent = currentParts.join('\n\n').trim();
      if (tailContent) {
        sections.push({
          heading: currentHeading,
          level: 2,
          content: tailContent,
          charCount: tailContent.length
        });
      }
      currentHeading = mdHeadingMatch[2].trim();
      currentParts = [];
      const remainder = firstNewline === -1 ? '' : rawBlock.slice(firstNewline + 1).trim();
      if (remainder) {
        currentParts.push(remainder);
      }
      continue;
    }

    const block = rawBlock;
    const isShortHeadingCandidate =
      !block.startsWith('|') &&
      !block.includes('\n') &&
      block.length >= 3 &&
      block.length <= 80 &&
      !/[.!?;:]$/.test(block) &&
      blocks.length > 2;

    if (isShortHeadingCandidate && currentParts.length > 0) {
      const content = currentParts.join('\n\n').trim();
      if (content) {
        sections.push({
          heading: currentHeading,
          level: 2,
          content,
          charCount: content.length
        });
      }
      currentHeading = block;
      currentParts = [];
      continue;
    }

    if (isShortHeadingCandidate && currentParts.length === 0 && currentHeading === 'Document Body') {
      currentHeading = block;
      continue;
    }

    currentParts.push(block);
  }

  const tail = currentParts.join('\n\n').trim();
  if (tail) {
    sections.push({
      heading: currentHeading,
      level: 2,
      content: tail,
      charCount: tail.length
    });
  } else if (sections.length === 0 && currentHeading !== 'Document Body') {
    sections.push({
      heading: 'Document Body',
      level: 2,
      content: currentHeading,
      charCount: currentHeading.length
    });
  }

  return sections;
}

/**
 * Extracts readable paragraphs, tables, footnotes/textboxes, and sections
 * from legacy binary Word (.doc) OLE2 MS-DOC documents.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer} inputBytes
 * @returns {Promise<Object>}
 */
export async function extractLegacyDocDocument(inputBytes) {
  const bytes = toUint8Array(inputBytes);

  if (bytes.length === 0) {
    return {
      status: 'empty',
      success: false,
      text: '',
      warning: 'The DOC file is empty (0 bytes).'
    };
  }

  if (bytes.length > MAX_EXTRACTION_INPUT_BYTES) {
    return {
      status: 'error',
      success: false,
      text: '',
      error: `Document exceeds the ${Math.round(MAX_EXTRACTION_INPUT_BYTES / (1024 * 1024))} MB extraction size limit.`
    };
  }

  if (hasZipSignature(bytes)) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: 'Invalid DOC file: file is an OpenXML ZIP container rather than a legacy binary .doc document.'
    };
  }

  if (!hasOle2Signature(bytes)) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: 'Invalid DOC file: missing OLE compound binary signature.'
    };
  }

  try {
    const cfbModule = await import('cfb');
    const CFB = cfbModule.default || cfbModule;

    let cfbDoc;
    try {
      cfbDoc = CFB.read(bytes, { type: 'array' });
    } catch (cfbErr) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: `Failed to parse DOC compound container: ${cfbErr?.message || 'Corrupted OLE2 structure.'}`
      };
    }

    if (
      findCfbEntryCaseInsensitive(cfbDoc, 'EncryptedPackage') ||
      findCfbEntryCaseInsensitive(cfbDoc, 'EncryptionInfo')
    ) {
      return {
        status: 'encrypted',
        success: false,
        text: '',
        error: 'This Word (.doc) document is encrypted or password-protected and cannot be read without a password.'
      };
    }

    const wordDocEntry = findCfbEntryCaseInsensitive(cfbDoc, 'WordDocument');
    if (!wordDocEntry) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: 'Invalid DOC document: missing WordDocument stream in OLE container.'
      };
    }

    const wordDoc = getCfbEntryBytes(wordDocEntry);
    if (wordDoc.length < 68) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: 'Invalid DOC document: WordDocument File Information Block (FIB) is truncated.'
      };
    }

    const fibView = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength);
    const wIdent = fibView.getUint16(0, true);
    if ((wIdent & 0xff00) !== 0xa500) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: 'Invalid DOC document: unrecognized Word FIB magic identifier.'
      };
    }

    const nFib = fibView.getUint16(2, true);
    const flags = fibView.getUint16(10, true);
    const fEncrypted = (flags & 0x0100) !== 0;
    const fObfuscated = (flags & 0x8000) !== 0;
    const fWhichTblStm = (flags & 0x0200) !== 0;

    if (fEncrypted || fObfuscated) {
      return {
        status: 'encrypted',
        success: false,
        text: '',
        error: 'This Word (.doc) document is encrypted or password-protected and cannot be read without a password.'
      };
    }

    // Parse variable FIB sections for Word 97-2003 (nFib >= 0x00C0)
    let ccpText = 0;
    let ccpFtn = 0;
    let ccpHdd = 0;
    let ccpMcr = 0;
    let ccpAtn = 0;
    let ccpEdn = 0;
    let ccpTxbx = 0;
    let fcClx = 0;
    let lcbClx = 0;
    let fibParsed = false;

    if (nFib >= 0x00c0 && wordDoc.length >= 36) {
      let pos = 32;
      const csw = fibView.getUint16(pos, true);
      pos += 2 + csw * 2;
      if (pos + 2 <= wordDoc.length) {
        const cslw = fibView.getUint16(pos, true);
        pos += 2;
        if (pos + cslw * 4 <= wordDoc.length) {
          if (cslw >= 4) ccpText = Math.max(0, fibView.getInt32(pos + 12, true));
          if (cslw >= 5) ccpFtn = Math.max(0, fibView.getInt32(pos + 16, true));
          if (cslw >= 6) ccpHdd = Math.max(0, fibView.getInt32(pos + 20, true));
          if (cslw >= 7) ccpMcr = Math.max(0, fibView.getInt32(pos + 24, true));
          if (cslw >= 8) ccpAtn = Math.max(0, fibView.getInt32(pos + 28, true));
          if (cslw >= 9) ccpEdn = Math.max(0, fibView.getInt32(pos + 32, true));
          if (cslw >= 10) ccpTxbx = Math.max(0, fibView.getInt32(pos + 36, true));
          pos += cslw * 4;
          if (pos + 2 <= wordDoc.length) {
            const cbRgFcLcb = fibView.getUint16(pos, true);
            pos += 2;
            const clxEntryOffset = pos + 33 * 8;
            if (cbRgFcLcb > 33 && clxEntryOffset + 8 <= wordDoc.length) {
              fcClx = fibView.getUint32(clxEntryOffset, true);
              lcbClx = fibView.getUint32(clxEntryOffset + 4, true);
              fibParsed = true;
            }
          }
        }
      }
    }

    const tableStreamName = fWhichTblStm ? '1Table' : '0Table';
    const tableEntry = findCfbEntryCaseInsensitive(cfbDoc, tableStreamName);
    const tableStream = tableEntry ? getCfbEntryBytes(tableEntry) : new Uint8Array(0);

    let logicalCpText = '';

    // Primary Word 97-2003 extraction via piece table (Clx -> Pcdt -> PlcPcd)
    if (fibParsed && lcbClx > 0 && tableStream.length > 0) {
      if (fcClx + lcbClx > tableStream.length) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Corrupted DOC file: piece table (Clx) bounds exceed Table stream size.'
        };
      }

      const tblView = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
      let clxPos = fcClx;
      const clxEnd = fcClx + lcbClx;

      // Skip optional Prc (property modifier) blocks (clxt === 0x01)
      let guard = 0;
      while (clxPos < clxEnd && tableStream[clxPos] === 0x01 && guard < 10_000) {
        guard++;
        if (clxPos + 3 > clxEnd) break;
        const cbGrpprl = tblView.getUint16(clxPos + 1, true);
        clxPos += 3 + cbGrpprl;
      }

      if (clxPos >= clxEnd || tableStream[clxPos] !== 0x02 || clxPos + 5 > clxEnd) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Corrupted DOC file: missing Pcdt piece descriptor table in Clx.'
        };
      }

      const pcdtLcb = tblView.getUint32(clxPos + 1, true);
      const plcPcdStart = clxPos + 5;
      if (plcPcdStart + pcdtLcb > clxEnd || pcdtLcb < 16) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Corrupted DOC file: invalid PlcPcd size in piece table.'
        };
      }

      const pieceCount = Math.floor((pcdtLcb - 4) / 12);
      if (pieceCount <= 0 || pieceCount > MAX_DOC_PIECES) {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Corrupted DOC file: piece count is out of valid bounds.'
        };
      }

      const cpArrayOffset = plcPcdStart;
      const pcdArrayOffset = plcPcdStart + (pieceCount + 1) * 4;
      const decodedPieces = [];

      for (let i = 0; i < pieceCount; i++) {
        const cpStart = tblView.getInt32(cpArrayOffset + i * 4, true);
        const cpEnd = tblView.getInt32(cpArrayOffset + (i + 1) * 4, true);
        const charLen = cpEnd - cpStart;
        if (charLen <= 0) continue;

        const fcRaw = tblView.getUint32(pcdArrayOffset + i * 8 + 2, true);
        const isCompressedAnsi = (fcRaw & 0x40000000) !== 0;
        const fcOffset = fcRaw & 0x3fffffff;

        if (isCompressedAnsi) {
          const byteOffset = fcOffset >>> 1;
          const avail = Math.max(0, Math.min(charLen, wordDoc.length - byteOffset));
          if (byteOffset < wordDoc.length && avail > 0) {
            decodedPieces.push(decodeCp1252(wordDoc.subarray(byteOffset, byteOffset + avail)));
          }
        } else {
          const byteOffset = fcOffset;
          const byteLen = charLen * 2;
          const avail = Math.max(0, Math.min(byteLen, wordDoc.length - byteOffset));
          const evenAvail = avail - (avail % 2);
          if (byteOffset < wordDoc.length && evenAvail > 0) {
            decodedPieces.push(decodeUtf16Le(wordDoc.subarray(byteOffset, byteOffset + evenAvail)));
          }
        }
      }

      logicalCpText = decodedPieces.join('');
    } else if (nFib < 0x00c0) {
      // Legacy Word 6.0 / Word 95 fallback: direct stream range fcMin..fcMac
      const fcMin = fibView.getUint32(0x18, true);
      const fcMac = fibView.getUint32(0x1c, true);
      if (fcMac > fcMin && fcMac <= wordDoc.length) {
        logicalCpText = decodeCp1252(wordDoc.subarray(fcMin, fcMac));
      } else {
        return {
          status: 'corrupted',
          success: false,
          text: '',
          error: 'Corrupted legacy Word 6/95 (.doc) file: invalid stream boundaries.'
        };
      }
    } else if (fibParsed && tableEntry && lcbClx === 0 && ccpText === 0) {
      logicalCpText = '';
    } else {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: `Corrupted DOC file: missing piece table stream (${tableStreamName}).`
      };
    }

    // Separate main document text and optional secondary streams (footnotes, endnotes, textboxes)
    const parts = [];
    if (ccpText > 0 && logicalCpText.length > 0) {
      const mainRaw = logicalCpText.slice(0, Math.min(ccpText, logicalCpText.length));
      const mainFormatted = formatWordBinaryTextStream(mainRaw);
      if (mainFormatted) {
        parts.push(mainFormatted);
      }

      // Append non-empty footnotes, endnotes, and text boxes in reading order after main document text
      let offset = ccpText;
      const ftnRaw = ccpFtn > 0 ? logicalCpText.slice(offset, offset + ccpFtn) : '';
      offset += ccpFtn;
      // Skip headers/footers (ccpHdd) & macros (ccpMcr)
      offset += ccpHdd + ccpMcr;
      const atnRaw = ccpAtn > 0 ? logicalCpText.slice(offset, offset + ccpAtn) : '';
      offset += ccpAtn;
      const ednRaw = ccpEdn > 0 ? logicalCpText.slice(offset, offset + ccpEdn) : '';
      offset += ccpEdn;
      const txbxRaw = ccpTxbx > 0 ? logicalCpText.slice(offset, offset + ccpTxbx) : '';

      const ftnFormatted = formatWordBinaryTextStream(ftnRaw);
      if (ftnFormatted && !parts[0]?.includes(ftnFormatted)) {
        parts.push(`### Footnotes\n${ftnFormatted}`);
      }
      const ednFormatted = formatWordBinaryTextStream(ednRaw);
      if (ednFormatted && !parts[0]?.includes(ednFormatted)) {
        parts.push(`### Endnotes\n${ednFormatted}`);
      }
      const atnFormatted = formatWordBinaryTextStream(atnRaw);
      if (atnFormatted && !parts[0]?.includes(atnFormatted)) {
        parts.push(`### Comments\n${atnFormatted}`);
      }
      const txbxFormatted = formatWordBinaryTextStream(txbxRaw);
      if (txbxFormatted && !parts[0]?.includes(txbxFormatted)) {
        parts.push(`### Text Boxes\n${txbxFormatted}`);
      }
    } else {
      const formatted = formatWordBinaryTextStream(logicalCpText);
      if (formatted) parts.push(formatted);
    }

    const fullText = parts.join('\n\n').trim();
    if (!fullText) {
      return {
        status: 'empty',
        success: false,
        text: '',
        warning: 'This Word (.doc) document contains no readable text content.'
      };
    }

    const sections = buildDocSectionsFromParagraphs(fullText);

    return {
      status: 'ready',
      success: true,
      text: fullText,
      sections,
      sectionCount: sections.length
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: `Failed to parse DOC document: ${err?.message || 'Invalid or corrupted binary Word structure.'}`
    };
  }
}

// MS-PPT Record Type constants
const PPT_RT_DOCUMENT = 1000;
const PPT_RT_SLIDE = 1006;
const PPT_RT_SLIDE_ATOM = 1007;
const PPT_RT_NOTES = 1008;
const PPT_RT_NOTES_ATOM = 1009;
const PPT_RT_SLIDE_PERSIST_ATOM = 1011;
const PPT_RT_TEXT_HEADER_ATOM = 3999;
const PPT_RT_TEXT_CHARS_ATOM = 4000;
const PPT_RT_TEXT_BYTES_ATOM = 4008;
const PPT_RT_CSTRING = 4026;
const PPT_RT_SLIDE_LIST_WITH_TEXT = 4080;
const PPT_RT_USER_EDIT_ATOM = 4085;
const PPT_RT_CURRENT_USER_ATOM = 4086;
const PPT_RT_PERSIST_DIRECTORY_ATOM = 6002;
const PPT_RT_CRYPT_SESSION_10_CONTAINER = 12052; // 0x2F14

function cleanPptString(raw) {
  if (!raw) return '';
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x0b/g, '\n')
    .replace(/[\x00-\x08\x0c-\x1f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readPptRecordHeader(view, offset, maxEnd) {
  if (offset + 8 > maxEnd) return null;
  const verAndInst = view.getUint16(offset, true);
  const recVer = verAndInst & 0x0f;
  const recInstance = verAndInst >> 4;
  const recType = view.getUint16(offset + 2, true);
  const recLen = view.getUint32(offset + 4, true);
  const payloadStart = offset + 8;
  const payloadEnd = payloadStart + recLen;
  if (payloadEnd > maxEnd || payloadEnd < payloadStart) return null;
  return {
    recVer,
    recInstance,
    recType,
    recLen,
    isContainer: recVer === 0x0f,
    offset,
    payloadStart,
    payloadEnd
  };
}

function walkPptRecords(bytes, view, start, end, onRecord, depth = 0) {
  if (depth > MAX_PPT_RECORD_DEPTH) return;
  let pos = start;
  let count = 0;
  while (pos + 8 <= end && count < 100_000) {
    count++;
    const hdr = readPptRecordHeader(view, pos, end);
    if (!hdr) break;
    onRecord(hdr, depth);
    if (hdr.isContainer) {
      walkPptRecords(bytes, view, hdr.payloadStart, hdr.payloadEnd, onRecord, depth + 1);
    }
    pos = hdr.payloadEnd;
  }
}

function parsePptPersistMap(pptStream, pptView, currentUserStream) {
  const persistMap = new Map();
  let docPersistIdRef = null;
  let hasEncryptedSession = false;

  if (!currentUserStream || currentUserStream.length < 16) {
    return { persistMap, docPersistIdRef, hasEncryptedSession };
  }

  try {
    const cuView = new DataView(
      currentUserStream.buffer,
      currentUserStream.byteOffset,
      currentUserStream.byteLength
    );
    const hdr = readPptRecordHeader(cuView, 0, currentUserStream.length);
    if (hdr && hdr.recType === PPT_RT_CURRENT_USER_ATOM && hdr.recLen >= 16) {
      // CurrentUserAtom headerToken at +4: 0xF3D1C4DF indicates encrypted PPT (0xE391C05F unencrypted)
      const headerToken = cuView.getUint32(hdr.payloadStart + 4, true);
      if (headerToken === 0xf3d1c4df) {
        hasEncryptedSession = true;
      }
      // offsetToCurrentEdit is at +8 within CurrentUserAtom payload (+4 size, +4 headerToken, +4 offsetToCurrentEdit)
      let editOffset = cuView.getUint32(hdr.payloadStart + 8, true);
      const visitedOffsets = new Set();
      const editChain = [];

      while (
        editOffset + 8 <= pptStream.length &&
        !visitedOffsets.has(editOffset) &&
        editChain.length < 512
      ) {
        visitedOffsets.add(editOffset);
        const editHdr = readPptRecordHeader(pptView, editOffset, pptStream.length);
        if (!editHdr || editHdr.recType !== PPT_RT_USER_EDIT_ATOM || editHdr.recLen < 24) {
          break;
        }
        const offsetLastEdit = pptView.getUint32(editHdr.payloadStart + 8, true);
        const offsetPersistDirectory = pptView.getUint32(editHdr.payloadStart + 12, true);
        const editDocPersistId = pptView.getUint32(editHdr.payloadStart + 16, true);
        const encryptSessionPersistIdRef =
          editHdr.recLen >= 28 ? pptView.getUint32(editHdr.payloadStart + 24, true) : 0;

        if (encryptSessionPersistIdRef !== 0) {
          hasEncryptedSession = true;
        }
        if (docPersistIdRef === null && editDocPersistId > 0) {
          docPersistIdRef = editDocPersistId;
        }

        editChain.push(offsetPersistDirectory);
        if (offsetLastEdit === 0 || offsetLastEdit === editOffset) break;
        editOffset = offsetLastEdit;
      }

      // Apply oldest-to-newest so latest offsets win
      for (let eIdx = editChain.length - 1; eIdx >= 0; eIdx--) {
        const pdOffset = editChain[eIdx];
        if (pdOffset + 8 > pptStream.length) continue;
        const pdHdr = readPptRecordHeader(pptView, pdOffset, pptStream.length);
        if (!pdHdr || pdHdr.recType !== PPT_RT_PERSIST_DIRECTORY_ATOM) continue;

        let p = pdHdr.payloadStart;
        while (p + 4 <= pdHdr.payloadEnd) {
          const val = pptView.getUint32(p, true);
          p += 4;
          const persistIdStart = val & 0x000fffff;
          const cPersist = (val >>> 20) & 0x0fff;
          for (let k = 0; k < cPersist && p + 4 <= pdHdr.payloadEnd; k++) {
            const objOffset = pptView.getUint32(p, true);
            p += 4;
            persistMap.set(persistIdStart + k, objOffset);
          }
        }
      }
    }
  } catch (_) {}

  return { persistMap, docPersistIdRef, hasEncryptedSession };
}

function extractTextAtomsFromContainer(bytes, view, start, end) {
  const texts = [];
  let currentTextType = null;

  walkPptRecords(bytes, view, start, end, (rec) => {
    if (rec.recType === PPT_RT_TEXT_HEADER_ATOM && rec.recLen >= 4) {
      currentTextType = view.getUint32(rec.payloadStart, true);
    } else if (rec.recType === PPT_RT_TEXT_CHARS_ATOM && rec.recLen >= 2) {
      const raw = decodeUtf16Le(bytes.subarray(rec.payloadStart, rec.payloadEnd));
      const clean = cleanPptString(raw);
      if (clean) {
        texts.push({ textType: currentTextType, text: clean });
      }
      currentTextType = null;
    } else if (rec.recType === PPT_RT_TEXT_BYTES_ATOM && rec.recLen >= 1) {
      const raw = decodeCp1252(bytes.subarray(rec.payloadStart, rec.payloadEnd));
      const clean = cleanPptString(raw);
      if (clean) {
        texts.push({ textType: currentTextType, text: clean });
      }
      currentTextType = null;
    }
  });

  return texts;
}

function extractSlideListEntries(bytes, view, containerHdr) {
  const entries = [];
  let activeEntry = null;
  let activeTextType = null;
  let pos = containerHdr.payloadStart;
  let count = 0;

  while (pos + 8 <= containerHdr.payloadEnd && count < 100_000) {
    count++;
    const rec = readPptRecordHeader(view, pos, containerHdr.payloadEnd);
    if (!rec) break;

    if (rec.recType === PPT_RT_SLIDE_PERSIST_ATOM && rec.recLen >= 20) {
      activeEntry = {
        persistIdRef: view.getUint32(rec.payloadStart, true),
        slideId: view.getUint32(rec.payloadStart + 12, true),
        texts: []
      };
      activeTextType = null;
      entries.push(activeEntry);
    } else if (activeEntry) {
      if (rec.recType === PPT_RT_TEXT_HEADER_ATOM && rec.recLen >= 4) {
        activeTextType = view.getUint32(rec.payloadStart, true);
      } else if (rec.recType === PPT_RT_TEXT_CHARS_ATOM && rec.recLen >= 2) {
        const clean = cleanPptString(decodeUtf16Le(bytes.subarray(rec.payloadStart, rec.payloadEnd)));
        if (clean) activeEntry.texts.push({ textType: activeTextType, text: clean });
        activeTextType = null;
      } else if (rec.recType === PPT_RT_TEXT_BYTES_ATOM && rec.recLen >= 1) {
        const clean = cleanPptString(decodeCp1252(bytes.subarray(rec.payloadStart, rec.payloadEnd)));
        if (clean) activeEntry.texts.push({ textType: activeTextType, text: clean });
        activeTextType = null;
      } else if (rec.isContainer) {
        const nested = extractTextAtomsFromContainer(bytes, view, rec.payloadStart, rec.payloadEnd);
        activeEntry.texts.push(...nested);
      }
    }
    pos = rec.payloadEnd;
  }

  return entries;
}

/**
 * Extracts readable slide-by-slide text, slide titles, textboxes, and speaker notes
 * from legacy binary PowerPoint (.ppt) OLE2 MS-PPT presentations.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer} inputBytes
 * @returns {Promise<Object>}
 */
export async function extractLegacyPptDocument(inputBytes) {
  const bytes = toUint8Array(inputBytes);

  if (bytes.length === 0) {
    return {
      status: 'empty',
      success: false,
      slideCount: 0,
      slides: [],
      text: '',
      warning: 'The PPT file is empty (0 bytes).'
    };
  }

  if (bytes.length > MAX_EXTRACTION_INPUT_BYTES) {
    return {
      status: 'error',
      success: false,
      text: '',
      error: `Presentation exceeds the ${Math.round(MAX_EXTRACTION_INPUT_BYTES / (1024 * 1024))} MB extraction size limit.`
    };
  }

  if (hasZipSignature(bytes)) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: 'Invalid PPT file: file is an OpenXML ZIP container rather than a legacy binary .ppt presentation.'
    };
  }

  if (!hasOle2Signature(bytes)) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: 'Invalid PPT file: missing OLE compound binary signature.'
    };
  }

  try {
    const cfbModule = await import('cfb');
    const CFB = cfbModule.default || cfbModule;

    let cfbDoc;
    try {
      cfbDoc = CFB.read(bytes, { type: 'array' });
    } catch (cfbErr) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: `Failed to parse PPT compound container: ${cfbErr?.message || 'Corrupted OLE2 structure.'}`
      };
    }

    if (
      findCfbEntryCaseInsensitive(cfbDoc, 'EncryptedPackage') ||
      findCfbEntryCaseInsensitive(cfbDoc, 'EncryptionInfo')
    ) {
      return {
        status: 'encrypted',
        success: false,
        text: '',
        error: 'This PowerPoint (.ppt) presentation is encrypted or password-protected and cannot be read without a password.'
      };
    }

    const pptEntry = findCfbEntryCaseInsensitive(cfbDoc, 'PowerPoint Document');
    if (!pptEntry) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: 'Invalid PPT presentation: missing PowerPoint Document stream in OLE container.'
      };
    }

    const pptStream = getCfbEntryBytes(pptEntry);
    if (pptStream.length < 8) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: 'Invalid PPT presentation: PowerPoint Document stream is empty or truncated.'
      };
    }

    const pptView = new DataView(pptStream.buffer, pptStream.byteOffset, pptStream.byteLength);
    const cuEntry = findCfbEntryCaseInsensitive(cfbDoc, 'Current User');
    const cuStream = cuEntry ? getCfbEntryBytes(cuEntry) : null;

    const { persistMap, docPersistIdRef, hasEncryptedSession } = parsePptPersistMap(
      pptStream,
      pptView,
      cuStream
    );

    if (hasEncryptedSession) {
      return {
        status: 'encrypted',
        success: false,
        text: '',
        error: 'This PowerPoint (.ppt) presentation is encrypted or password-protected and cannot be read without a password.'
      };
    }

    // Validate top-level record stream integrity & detect CryptSession10Container
    let foundAnyValidRecord = false;
    let foundEncryptionRecord = false;
    let lastDocumentHdr = null;
    const allSlideHdrs = [];
    const allNotesHdrs = [];

    let topPos = 0;
    let topCount = 0;
    while (topPos + 8 <= pptStream.length && topCount < 50_000) {
      topCount++;
      const hdr = readPptRecordHeader(pptView, topPos, pptStream.length);
      if (!hdr) break;
      foundAnyValidRecord = true;

      if (hdr.recType === PPT_RT_CRYPT_SESSION_10_CONTAINER) {
        foundEncryptionRecord = true;
      } else if (hdr.recType === PPT_RT_DOCUMENT) {
        lastDocumentHdr = hdr;
      } else if (hdr.recType === PPT_RT_SLIDE) {
        allSlideHdrs.push(hdr);
      } else if (hdr.recType === PPT_RT_NOTES) {
        allNotesHdrs.push(hdr);
      }

      if (hdr.isContainer) {
        walkPptRecords(pptStream, pptView, hdr.payloadStart, hdr.payloadEnd, (child) => {
          if (child.recType === PPT_RT_CRYPT_SESSION_10_CONTAINER) {
            foundEncryptionRecord = true;
          }
        });
      }

      topPos = hdr.payloadEnd;
    }

    if (foundEncryptionRecord) {
      return {
        status: 'encrypted',
        success: false,
        text: '',
        error: 'This PowerPoint (.ppt) presentation is encrypted or password-protected and cannot be read without a password.'
      };
    }

    if (!foundAnyValidRecord) {
      return {
        status: 'corrupted',
        success: false,
        text: '',
        error: 'Invalid PPT presentation: no valid PowerPoint binary records found.'
      };
    }

    // Resolve active DocumentContainer (preferring Current User PersistDirectory lookup)
    let activeDocHdr = lastDocumentHdr;
    if (docPersistIdRef !== null && persistMap.has(docPersistIdRef)) {
      const docOffset = persistMap.get(docPersistIdRef);
      const resolvedHdr = readPptRecordHeader(pptView, docOffset, pptStream.length);
      if (resolvedHdr && resolvedHdr.recType === PPT_RT_DOCUMENT) {
        activeDocHdr = resolvedHdr;
      }
    }

    // Map NotesContainers by referenced slideId
    const notesBySlideId = new Map();
    for (const notesHdr of allNotesHdrs) {
      let refSlideId = null;
      walkPptRecords(pptStream, pptView, notesHdr.payloadStart, notesHdr.payloadEnd, (rec) => {
        if (rec.recType === PPT_RT_NOTES_ATOM && rec.recLen >= 8 && refSlideId === null) {
          refSlideId = pptView.getUint32(rec.payloadStart, true);
        }
      });
      if (refSlideId && refSlideId !== 0) {
        const noteTexts = extractTextAtomsFromContainer(
          pptStream,
          pptView,
          notesHdr.payloadStart,
          notesHdr.payloadEnd
        )
          .map((t) => t.text)
          .filter(Boolean);
        if (noteTexts.length > 0) {
          notesBySlideId.set(refSlideId, noteTexts.join('\n').trim());
        }
      }
    }

    // Collect SlideListWithText entries from active DocumentContainer
    let slideListEntries = [];
    let notesListEntries = [];

    if (activeDocHdr) {
      let pos = activeDocHdr.payloadStart;
      let count = 0;
      while (pos + 8 <= activeDocHdr.payloadEnd && count < 10_000) {
        count++;
        const rec = readPptRecordHeader(pptView, pos, activeDocHdr.payloadEnd);
        if (!rec) break;
        if (rec.recType === PPT_RT_SLIDE_LIST_WITH_TEXT) {
          if (rec.recInstance === 0) {
            slideListEntries = extractSlideListEntries(pptStream, pptView, rec);
          } else if (rec.recInstance === 2) {
            notesListEntries = extractSlideListEntries(pptStream, pptView, rec);
          }
          // Intentionally skip recInstance === 1 (Master slides template placeholders)
        }
        pos = rec.payloadEnd;
      }
    }

    // Helper to resolve SlideContainer texts by persistIdRef
    const readSlideContainerTextsByOffset = (slideOffset) => {
      const hdr = readPptRecordHeader(pptView, slideOffset, pptStream.length);
      if (!hdr || hdr.recType !== PPT_RT_SLIDE) return [];
      return extractTextAtomsFromContainer(pptStream, pptView, hdr.payloadStart, hdr.payloadEnd);
    };

    const slides = [];
    const aggregatedSlideTexts = [];

    if (slideListEntries.length > 0) {
      for (let i = 0; i < slideListEntries.length; i++) {
        const entry = slideListEntries[i];
        const slideNum = i + 1;
        const collectedTexts = [...entry.texts];

        // Also pull textboxes/shapes directly from referenced SlideContainer if present via PersistMap
        if (entry.persistIdRef && persistMap.has(entry.persistIdRef)) {
          const containerTexts = readSlideContainerTextsByOffset(persistMap.get(entry.persistIdRef));
          for (const ct of containerTexts) {
            if (!collectedTexts.some((existing) => existing.text === ct.text)) {
              collectedTexts.push(ct);
            }
          }
        }

        // Identify slide title (TextHeaderAtom type 0 = Title, 6 = CenterTitle)
        let slideTitle = undefined;
        const bodyItems = [];
        for (const item of collectedTexts) {
          const isTitleType = item.textType === 0 || item.textType === 6;
          if (isTitleType && !slideTitle) {
            slideTitle = item.text.replace(/\n+/g, ' ').trim();
          } else if (item.text) {
            if (!slideTitle || item.text !== slideTitle) {
              bodyItems.push(item.text);
            }
          }
        }

        const slideBody = bodyItems.join('\n\n').trim();
        const effectiveText = slideTitle
          ? slideBody
            ? `${slideTitle}\n\n${slideBody}`
            : slideTitle
          : slideBody || '';

        let notesText = notesBySlideId.get(entry.slideId);
        if (!notesText && notesListEntries[i]?.texts?.length > 0) {
          notesText = notesListEntries[i].texts.map((t) => t.text).join('\n').trim();
        }

        slides.push({
          slideNumber: slideNum,
          title: slideTitle,
          text: effectiveText,
          notes: notesText || undefined,
          charCount: effectiveText.length
        });

        const titleHeader = slideTitle ? `: ${slideTitle}` : '';
        let slideFormatted = `--- Slide ${slideNum}${titleHeader} ---\n${effectiveText || '[Empty slide]'}`;
        if (notesText) {
          slideFormatted += `\n[Speaker Notes]: ${notesText}`;
        }
        aggregatedSlideTexts.push(slideFormatted);
      }
    } else if (allSlideHdrs.length > 0) {
      // Fallback when DocumentContainer lacks SlideListWithText: extract directly from SlideContainers
      for (let i = 0; i < allSlideHdrs.length; i++) {
        const hdr = allSlideHdrs[i];
        const slideNum = i + 1;
        const collectedTexts = extractTextAtomsFromContainer(
          pptStream,
          pptView,
          hdr.payloadStart,
          hdr.payloadEnd
        );

        let slideTitle = undefined;
        const bodyItems = [];
        for (const item of collectedTexts) {
          const isTitleType = item.textType === 0 || item.textType === 6;
          if (isTitleType && !slideTitle) {
            slideTitle = item.text.replace(/\n+/g, ' ').trim();
          } else if (item.text) {
            if (!slideTitle || item.text !== slideTitle) {
              bodyItems.push(item.text);
            }
          }
        }

        const slideBody = bodyItems.join('\n\n').trim();
        const effectiveText = slideTitle
          ? slideBody
            ? `${slideTitle}\n\n${slideBody}`
            : slideTitle
          : slideBody || '';

        slides.push({
          slideNumber: slideNum,
          title: slideTitle,
          text: effectiveText,
          charCount: effectiveText.length
        });

        const titleHeader = slideTitle ? `: ${slideTitle}` : '';
        aggregatedSlideTexts.push(`--- Slide ${slideNum}${titleHeader} ---\n${effectiveText || '[Empty slide]'}`);
      }
    }

    if (slides.length === 0) {
      return {
        status: 'empty',
        success: false,
        slideCount: 0,
        slides: [],
        text: '',
        warning: 'No presentation slides were found in this PPT file.'
      };
    }

    const totalContentChars = slides.reduce((acc, s) => acc + s.charCount + (s.notes ? s.notes.length : 0), 0);
    const fullText = aggregatedSlideTexts.join('\n\n').trim();

    if (totalContentChars === 0) {
      return {
        status: 'empty',
        success: false,
        slideCount: slides.length,
        slides,
        text: fullText,
        warning: 'The PPT presentation was read successfully, but all slides are empty or contain only graphics.'
      };
    }

    return {
      status: 'ready',
      success: true,
      slideCount: slides.length,
      slides,
      text: fullText
    };
  } catch (err) {
    return {
      status: 'corrupted',
      success: false,
      text: '',
      error: `Failed to parse PPT presentation: ${err?.message || 'Invalid or corrupted PowerPoint binary structure.'}`
    };
  }
}
