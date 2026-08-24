package com.switchboard.domain.evaluation;

import java.util.UUID;

/** Result of evaluating one flag for one context. {@code ruleId} is set only for RULE_MATCH. */
public record EvalOutcome(UUID variationId, String value, EvalReason reason, UUID ruleId) {
}
