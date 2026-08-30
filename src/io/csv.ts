/**
 * Delimited-text parsing for trajectory and pose-capture imports.
 *
 * Rows become records keyed by the header row, which is all the rest of the
 * pipeline needs: a CSV of joint angles lands on the same code path as a JSON
 * frame with the same field names, and a CSV of pose landmarks on the same path
 * as its JSON equivalent. Values are left as strings, since every consumer
 * already coerces and has to cope with entries like "nan" regardless.
 */

const DELIMITERS = [',', '\t', ';', '|'] as const;

/** Counts a candidate delimiter in the header, ignoring quoted sections. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(headerLine: string): string {
  let best: string = DELIMITERS[0];
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = countOutsideQuotes(headerLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Splits into rows and fields, honouring quotes around embedded separators. */
function tokenize(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote is a literal quote, per RFC 4180.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      started = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
      started = true;
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else if (char !== '\r') {
      field += char;
      started = true;
    }
  }

  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * True when the text is more plausibly delimited than JSON. Checked against the
 * first meaningful line so a leading comment or blank line does not decide it.
 */
export function looksDelimited(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^\uFEFF/, '');
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
    return DELIMITERS.some((delimiter) => countOutsideQuotes(trimmed, delimiter) > 0);
  }
  return false;
}

/** Parses delimited text into one record per row, keyed by the header row. */
export function parseDelimited(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^\uFEFF/, '');

  const firstBreak = clean.indexOf('\n');
  const headerLine = firstBreak === -1 ? clean : clean.slice(0, firstBreak);
  const delimiter = detectDelimiter(headerLine);

  const rows = tokenize(clean, delimiter).filter(
    (row) => !(row.length === 1 && row[0].trim() === '') && !row[0].trim().startsWith('#'),
  );
  if (rows.length < 2) return [];

  const headers = rows[0].map((header, index) => header.trim() || `column_${index}`);

  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim();
    });
    return record;
  });
}
