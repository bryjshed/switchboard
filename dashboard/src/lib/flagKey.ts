// The backend enforces `^[a-z][a-z0-9-]*$` (max 128) on flag, project, environment and
// segment keys. Keeping the slugifier and the validator side by side means the auto-slug can
// never produce something the validator would reject.
export const KEY_PATTERN = /^[a-z][a-z0-9-]*$/
export const KEY_MAX_LENGTH = 128

/**
 * Derives a key from a human name: lowercase, non-alphanumerics collapse to single hyphens,
 * leading digits/hyphens are dropped so the result always starts with a letter.
 */
export function slugify(input: string, maxLength = KEY_MAX_LENGTH): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '')
  return slug.slice(0, maxLength).replace(/-+$/, '')
}

/** null when valid, else a message fit for a field-level error. */
export function validateKey(key: string, noun = 'Key'): string | null {
  if (!key) return `${noun} is required`
  if (key.length > KEY_MAX_LENGTH) return `${noun} must be ${KEY_MAX_LENGTH} characters or fewer`
  if (!KEY_PATTERN.test(key)) {
    return `${noun} must start with a lowercase letter and use only lowercase letters, numbers and hyphens`
  }
  return null
}
