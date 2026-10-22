import { readdir } from 'node:fs/promises';
const files = (await readdir(new URL('.', import.meta.url))).filter(name => name.endsWith('.test.ts')).sort();
for (const filename of files) await import(new URL(filename, import.meta.url).href);
