import { createReadStream, writeSync } from 'node:fs';
import { Writable } from 'node:stream';

// The managed test runtime substitutes child streams. Preserve real MCP stdio
// descriptors without changing the production CLI or substituting HTTP calls.
if (process.stdin.constructor.name === 'Readable' && process.stdout.constructor.name === 'Writable') {
  Object.defineProperty(process, 'stdin', { value: createReadStream('', { fd: 0, autoClose: false }) });
  Object.defineProperty(process, 'stdout', { value: new Writable({
    write(chunk, _encoding, callback) {
      try { writeSync(1, chunk); callback(); } catch (error) { callback(error); }
    },
  }) });
}
