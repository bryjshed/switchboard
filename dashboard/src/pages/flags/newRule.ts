import type { Rule } from '@/types/api'

/**
 * Rule ids are parsed as UUIDs by the backend, so a new rule must be given a real one here —
 * a slug or an array index would be rejected on save.
 */
export function newRule(defaultVariationId: string): Rule {
  return {
    id: crypto.randomUUID(),
    clauses: [{ attribute: 'key', op: 'EQUALS', values: [] }],
    serve: { variationId: defaultVariationId },
  }
}
