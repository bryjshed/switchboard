package com.switchboard.interfaces.rest.ofrep;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

/** OFREP {@code bulkEvaluationSuccess}: every flag of the environment, plus flag-set metadata. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record OfrepBulkEvaluationResponse(
    List<OfrepFlagEvaluation> flags,
    Map<String, Object> metadata,
    List<OfrepEventStream> eventStreams) {
}
