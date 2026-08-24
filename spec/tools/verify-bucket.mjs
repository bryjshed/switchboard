#!/usr/bin/env node
// Reference reimplementation of the Switchboard bucketing algorithm in ~4 lines of JavaScript,
// checked against spec/conformance/bucket.json. This is step 1 for any new SDK: if bucket()
// disagrees here, every rollout vector will disagree too.
//
//   node spec/tools/verify-bucket.mjs            check the vectors
//   node spec/tools/verify-bucket.mjs --print    also print each vector
//
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const BUCKET_SPACE = 10000;

export function bucket(flagKey, contextKey) {
  const hex = createHash('md5').update(`${flagKey}:${contextKey}`, 'utf8').digest('hex');
  return parseInt(hex.slice(0, 8), 16) % BUCKET_SPACE;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectorFile = join(here, '..', 'conformance', 'bucket.json');
const doc = JSON.parse(readFileSync(vectorFile, 'utf8'));
const print = process.argv.includes('--print');

let failures = 0;
for (const v of doc.bucketVectors) {
  const hex = createHash('md5').update(`${v.flagKey}:${v.contextKey}`, 'utf8').digest('hex');
  const prefixHex = hex.slice(0, 8);
  const prefixInt = parseInt(prefixHex, 16);
  const actual = prefixInt % BUCKET_SPACE;
  const ok = hex === v.md5Hex && prefixHex === v.prefixHex
    && prefixInt === v.prefixInt && actual === v.bucket;
  if (!ok) {
    failures++;
    console.error(`FAIL ${JSON.stringify(v.input)}`);
    console.error(`  expected md5=${v.md5Hex} prefix=${v.prefixHex} int=${v.prefixInt} bucket=${v.bucket}`);
    console.error(`  actual   md5=${hex} prefix=${prefixHex} int=${prefixInt} bucket=${actual}`);
  } else if (print) {
    console.log(`ok   ${JSON.stringify(v.input).padEnd(42)} ${prefixHex} ${String(prefixInt).padStart(10)} -> ${actual}`);
  }
}

console.log(`${doc.bucketVectors.length - failures}/${doc.bucketVectors.length} bucket vectors match (BUCKET_SPACE=${doc.bucketSpace}).`);
process.exit(failures === 0 ? 0 : 1);
