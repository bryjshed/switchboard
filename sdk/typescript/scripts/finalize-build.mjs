#!/usr/bin/env node
// tsc emits both builds as bare .js. Node decides ESM vs CJS from the nearest package.json's
// "type", and the package root says "module" - so dist/cjs needs its own marker or every require()
// of it fails with ERR_REQUIRE_ESM.
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['dist/cjs', { type: 'commonjs' }],
  ['dist/esm', { type: 'module' }],
];

for (const [dir, contents] of targets) {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) {
    throw new Error(`expected build output at ${dir}; run the tsc builds first`);
  }
  writeFileSync(join(absolute, 'package.json'), `${JSON.stringify(contents, null, 2)}\n`);
}

console.log('wrote dist/cjs/package.json and dist/esm/package.json');
