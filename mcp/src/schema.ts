import { z } from 'zod';

/**
 * Zod → JSON Schema, covering exactly the shapes the tool definitions use.
 *
 * A dependency (`zod-to-json-schema`) would do this in general. This does not need the general
 * case: every tool schema here is a flat object of strings, numbers, booleans and one `unknown`,
 * and keeping it in-tree means the MCP server has two runtime dependencies rather than three and
 * no surprises about which JSON Schema dialect gets emitted.
 *
 * It throws on anything it does not understand rather than silently emitting `{}`, because a tool
 * whose schema quietly becomes "any object" is one a model will call wrongly and confidently.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const object = unwrapObject(schema);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(object.shape)) {
    const field = value as z.ZodTypeAny;
    const { schema: fieldSchema, optional } = describe(field);
    properties[key] = fieldSchema;
    if (!optional) {
      required.push(key);
    }
  }

  const result: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) {
    result['required'] = required;
  }
  return result;
}

function unwrapObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  if (schema instanceof z.ZodObject) {
    return schema as z.ZodObject<z.ZodRawShape>;
  }
  throw new TypeError('Tool schemas must be objects');
}

function describe(field: z.ZodTypeAny): { schema: Record<string, unknown>; optional: boolean } {
  let current = field;
  let optional = false;
  let description: string | undefined = current.description;

  // Peel wrappers, keeping the outermost description: `.describe()` may sit on either side of
  // `.optional()` depending on the order the tool author wrote them in.
  for (;;) {
    description ??= current.description;
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      optional = optional || current instanceof z.ZodOptional;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    break;
  }

  const base = baseSchema(current);
  if (description !== undefined) {
    base['description'] = description;
  }
  return { schema: base, optional };
}

function baseSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodNumber) {
    return schema.isInt ? { type: 'integer' } : { type: 'number' };
  }
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    // Genuinely arbitrary: a targeting config, passed straight back from get_flag.
    return {};
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: baseSchema(schema.element as z.ZodTypeAny) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema.options };
  }
  if (schema instanceof z.ZodObject) {
    return zodToJsonSchema(schema);
  }
  throw new TypeError(
    `Unsupported schema type in a tool definition: ${schema.constructor.name}. ` +
      'Add it here rather than letting the tool advertise an untyped argument.',
  );
}
