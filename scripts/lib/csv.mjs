// Minimal streaming CSV parser: handles quoted fields, escaped quotes and newlines inside quotes.
import { createReadStream } from 'node:fs';

export async function* readCsv(path, { encoding = 'latin1' } = {}) {
  const stream = createReadStream(path, { encoding, highWaterMark: 1 << 20 });
  let row = [], field = '', inQuotes = false, pendingQuote = false;
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false;
          if (c === '"') { field += '"'; continue; }
          inQuotes = false; // closing quote, fall through to handle c normally
        } else if (c === '"') { pendingQuote = true; continue; }
        else { field += c; continue; }
      }
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); field = ''; yield row; row = []; }
      else if (c !== '\r') { field += c; }
    }
  }
  if (pendingQuote) inQuotes = false;
  if (field !== '' || row.length) { row.push(field); yield row; }
}
