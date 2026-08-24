package com.switchboard.interfaces.rest.ofrep;

import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.EvalOutcome;
import com.switchboard.domain.evaluation.EvalReason;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagAndConfig;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.domain.flag.Variation;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The whole OFREP adapter: Switchboard evaluation in, OFREP wire shapes out.
 *
 * <p>OFREP is a wire adapter and nothing more - evaluation itself stays in
 * {@link com.switchboard.domain.evaluation.FlagEvaluator}, so an OFREP answer and an
 * {@code /api/eval} answer for the same flag and context are the same decision, differently
 * spelled.
 */
public final class OfrepMappers {

    /** Prefix for the native detail OFREP has no field for; OFREP metadata is free-form by design. */
    private static final String META_PREFIX = "switchboard.";

    private OfrepMappers() {
    }

    // ---------------------------------------------------------------- request

    /**
     * Turns an OFREP context into a Switchboard {@link EvalContext}.
     *
     * <p>{@code targetingKey} is the Switchboard context key. Every other property becomes an
     * attribute, and since Switchboard attributes are {@code Map<String,String>} the scalars are
     * coerced with {@code String.valueOf}: booleans become "true"/"false" and numbers become their
     * JSON text (so {@code 42} is "42" and {@code 4.5} is "4.5"). Nested objects and arrays are
     * SKIPPED rather than stringified - a targeting rule can do nothing useful with
     * {@code "{a=1, b=2}"}, and inventing a flattening here would be a Switchboard dialect no
     * OpenFeature provider knows about. Nulls are skipped too: an absent attribute never matches a
     * clause, which is the same answer as a null one.
     *
     * @param flagKey the flag key for single evaluation, null on the bulk endpoint
     */
    public static EvalContext toEvalContext(OfrepEvaluationRequest request, String flagKey) {
        Object raw = request == null ? null : request.context();
        if (raw == null) {
            throw new OfrepBadRequestException(flagKey, OfrepErrorCode.TARGETING_KEY_MISSING,
                "Evaluation context is required and must carry a targetingKey");
        }
        if (!(raw instanceof Map<?, ?> context)) {
            throw new OfrepBadRequestException(flagKey, OfrepErrorCode.INVALID_CONTEXT,
                "Evaluation context must be a JSON object");
        }
        Object targetingKey = context.get("targetingKey");
        if (!(targetingKey instanceof String key) || key.isBlank()) {
            throw new OfrepBadRequestException(flagKey, OfrepErrorCode.TARGETING_KEY_MISSING,
                "Evaluation context is missing a non-empty string targetingKey");
        }
        Map<String, String> attributes = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : context.entrySet()) {
            String name = String.valueOf(entry.getKey());
            if ("targetingKey".equals(name)) {
                continue;
            }
            coerce(entry.getValue()).ifPresent(value -> attributes.put(name, value));
        }
        return new EvalContext(key, attributes);
    }

    /** Scalars stringify; objects, arrays and nulls are dropped. */
    private static Optional<String> coerce(Object value) {
        if (value instanceof String string) {
            return Optional.of(string);
        }
        if (value instanceof Boolean || value instanceof Number) {
            return Optional.of(String.valueOf(value));
        }
        return Optional.empty();
    }

    // ---------------------------------------------------------------- response

    /** One evaluated flag as OFREP's {@code evaluationSuccess}. */
    public static OfrepEvaluationSuccess toSuccess(FlagAndConfig flagAndConfig, EvalOutcome outcome) {
        Flag flag = flagAndConfig.flag();
        return new OfrepEvaluationSuccess(
            flag.key(),
            toValue(flag.kind(), outcome.value()),
            toReason(outcome),
            toVariant(flag, outcome),
            toMetadata(flagAndConfig, outcome));
    }

    /**
     * OFREP reason from the Switchboard reason.
     *
     * <pre>
     * KILL_SWITCH  -&gt; DISABLED          TARGET_MATCH -&gt; TARGETING_MATCH
     * FLAG_OFF     -&gt; DISABLED          RULE_MATCH   -&gt; TARGETING_MATCH
     * ROLLOUT      -&gt; SPLIT             DEFAULT      -&gt; STATIC
     * SDK_DEFAULT  -&gt; UNKNOWN (unreachable here: an unknown flag is FLAG_NOT_FOUND on this surface)
     * </pre>
     *
     * <p>A resolved variation that no longer exists on the flag also reports UNKNOWN: Switchboard
     * reached a decision but cannot name a value for it, which is exactly what UNKNOWN means.
     */
    public static OfrepReason toReason(EvalOutcome outcome) {
        if (outcome.value() == null) {
            return OfrepReason.UNKNOWN;
        }
        return switch (outcome.reason()) {
            case KILL_SWITCH, FLAG_OFF -> OfrepReason.DISABLED;
            case TARGET_MATCH, RULE_MATCH -> OfrepReason.TARGETING_MATCH;
            case ROLLOUT -> OfrepReason.SPLIT;
            case DEFAULT -> OfrepReason.STATIC;
            case SDK_DEFAULT -> OfrepReason.UNKNOWN;
        };
    }

    /**
     * Switchboard stores every variation value as a string; OFREP is typed.
     *
     * <p>BOOLEAN flags therefore emit a real JSON boolean. STRING flags emit the string verbatim -
     * no sniffing for numbers or JSON objects, because OpenFeature type-checks client side and a
     * wrong guess turns a working string flag into a TYPE_MISMATCH. A missing variation falls back
     * to the empty value for the kind, paired with reason UNKNOWN above.
     */
    public static Object toValue(FlagKind kind, String value) {
        if (kind == FlagKind.BOOLEAN) {
            return Boolean.parseBoolean(value);
        }
        return value == null ? "" : value;
    }

    /** OFREP's variant is the variation's name, falling back to its value when unnamed. */
    private static String toVariant(Flag flag, EvalOutcome outcome) {
        Variation variation = flag.variationById(outcome.variationId());
        if (variation == null) {
            return null;
        }
        return variation.name() == null || variation.name().isBlank() ? variation.value() : variation.name();
    }

    /**
     * Everything OFREP has no field for. Nothing Switchboard knows about an evaluation is dropped:
     * the native reason, the flag's per-environment config version, the variation and (for a rule
     * match) the rule that decided it. OFREP metadata values must be scalars, so ids go as strings.
     */
    private static Map<String, Object> toMetadata(FlagAndConfig flagAndConfig, EvalOutcome outcome) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put(META_PREFIX + "reason", outcome.reason().name());
        metadata.put(META_PREFIX + "flagVersion", flagAndConfig.config().version());
        metadata.put(META_PREFIX + "flagKind", flagAndConfig.flag().kind().name());
        if (outcome.variationId() != null) {
            metadata.put(META_PREFIX + "variationId", outcome.variationId().toString());
        }
        if (outcome.reason() == EvalReason.RULE_MATCH && outcome.ruleId() != null) {
            metadata.put(META_PREFIX + "ruleId", outcome.ruleId().toString());
        }
        return metadata;
    }
}
