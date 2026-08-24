import { createHash } from 'node:crypto';

/**
 * Size of the bucket space: {@link bucket} returns an integer in `[0, BUCKET_SPACE)`.
 *
 * 10000 rather than 100 so one whole percent of rollout weight covers exactly 100 buckets
 * (spec/evaluation.md 5.4).
 */
export const BUCKET_SPACE = 10_000;

/** Scales a whole-percent rollout weight into {@link BUCKET_SPACE}. */
export const WEIGHT_SCALE = BUCKET_SPACE / 100;

/**
 * Deterministic bucket for a (flag, context) pair.
 *
 * ```
 * bucket = int(hex(md5(flagKey + ":" + contextKey))[0:8], 16) % BUCKET_SPACE
 * ```
 *
 * The first 8 hex characters are the digest's first 4 bytes read big-endian as an UNSIGNED 32-bit
 * integer. JavaScript numbers are doubles, so `parseInt(hex, 16)` is already unsigned and exact for
 * values below 2^53 - there is no signed-overflow trap here, unlike in languages with int32.
 *
 * MD5 is part of the cross-language wire contract, chosen for ubiquity and not for security
 * (spec/evaluation.md 5.2). Do not "upgrade" it: doing so reassigns every context in every
 * in-flight rollout.
 */
export function bucket(flagKey: string, contextKey: string): number {
  const hex = createHash('md5').update(`${flagKey}:${contextKey}`, 'utf8').digest('hex');
  return parseInt(hex.slice(0, 8), 16) % BUCKET_SPACE;
}
