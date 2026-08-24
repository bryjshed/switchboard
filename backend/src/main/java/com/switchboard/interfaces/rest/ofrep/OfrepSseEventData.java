package com.switchboard.interfaces.rest.ofrep;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * OFREP {@code sseEventData}: the JSON payload inside an SSE {@code data:} line.
 *
 * <p>{@code etag} carries the same quoted value as the bulk endpoint's ETag header, so a provider
 * can hand it straight back as {@code flagConfigEtag} or {@code If-None-Match}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record OfrepSseEventData(String type, String etag) {

    public static final String REFETCH_EVALUATION = "refetchEvaluation";
}
