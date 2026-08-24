package com.switchboard.interfaces.rest.ofrep;

/**
 * Request body of both evaluate endpoints: <code>{ "context": { "targetingKey": ..., ... } }</code>.
 *
 * <p>{@code context} is typed as {@link Object} rather than a map on purpose. OFREP wants a
 * malformed body to be {@code PARSE_ERROR} but a well-formed body whose {@code context} is not an
 * object to be {@code INVALID_CONTEXT}; binding to a map would collapse both into a Jackson
 * decoding failure. {@link OfrepMappers#toEvalContext} does the discrimination.
 */
public record OfrepEvaluationRequest(Object context) {
}
