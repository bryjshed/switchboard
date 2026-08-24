/**
 * RFC-4122 v4 id generator. Client-side rule ids must be UUIDs (the backend's
 * Rule record parses them as one), and no crypto module is installed — these
 * ids only need to be unique, never unguessable.
 */
export function uuidv4(): string {
  const hex: string[] = [];
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      hex.push('-');
    } else if (i === 14) {
      hex.push('4');
    } else if (i === 19) {
      hex.push(((Math.random() * 4) | 8).toString(16));
    } else {
      hex.push(((Math.random() * 16) | 0).toString(16));
    }
  }
  return hex.join('');
}
