package com.switchboard.sdk;

import com.switchboard.domain.evaluation.EvalReason;
import java.util.UUID;

/**
 * One evaluation's answer, with why.
 *
 * <p>{@code reason} is Switchboard's own vocabulary rather than OpenFeature's, because it is
 * strictly finer: {@code KILL_SWITCH} and {@code FLAG_OFF} are both OpenFeature's
 * {@code DISABLED}, and {@code TARGET_MATCH} and {@code RULE_MATCH} are both
 * {@code TARGETING_MATCH}. The provider maps to OpenFeature at its boundary and preserves the
 * precise reason in flag metadata, so the distinction the dashboard and the audit trail rely
 * on is never lost on the way out.
 *
 * @param value        the served variation's value, or the caller's default
 * @param reason       why this value was served
 * @param variationId  the variation served, null when the caller's default was used
 * @param ruleId       the rule that matched, when {@code reason} is RULE_MATCH
 * @param errorKind    null unless something went wrong; the value is still safe to use
 * @param errorMessage human-readable detail for logs
 */
public record EvaluationDetail<T>(
    T value,
    EvalReason reason,
    UUID variationId,
    UUID ruleId,
    ErrorKind errorKind,
    String errorMessage) {

    /** Why an evaluation could not be completed. The caller's default is served regardless. */
    public enum ErrorKind {
        /** No such flag in the current snapshot. */
        FLAG_NOT_FOUND,
        /** The variation's value could not be read as the requested type. */
        PARSE_ERROR,
        /** No context key, so there is nothing to bucket on. */
        INVALID_CONTEXT,
        /** The client has no snapshot yet - not started, or the first fetch has not landed. */
        CLIENT_NOT_READY
    }

    public static <T> EvaluationDetail<T> of(T value, EvalReason reason, UUID variationId, UUID ruleId) {
        return new EvaluationDetail<>(value, reason, variationId, ruleId, null, null);
    }

    /** An error result. The value is the caller's default and is always safe to use. */
    public static <T> EvaluationDetail<T> error(T fallback, ErrorKind kind, String message) {
        return new EvaluationDetail<>(fallback, EvalReason.SDK_DEFAULT, null, null, kind, message);
    }

    public boolean isError() {
        return errorKind != null;
    }
}
