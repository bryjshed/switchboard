package com.switchboard.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.switchboard.domain.evaluation.AttributeValue;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.EvalReason;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.EvaluationContext;
import dev.openfeature.sdk.FeatureProvider;
import dev.openfeature.sdk.ImmutableMetadata;
import dev.openfeature.sdk.Metadata;
import dev.openfeature.sdk.ProviderEvaluation;
import dev.openfeature.sdk.ProviderState;
import dev.openfeature.sdk.Reason;
import dev.openfeature.sdk.Value;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * OpenFeature provider backed by {@link SwitchboardClient}.
 *
 * <pre>{@code
 * var provider = new SwitchboardProvider(SwitchboardConfig.builder(sdkKey).build());
 * OpenFeature.getInstance().setProviderAndWait(provider);
 * var client = OpenFeature.getInstance().getClient();
 * boolean on = client.getBooleanValue("new-checkout", false,
 *     new MutableContext("user-3").add("plan", "pro"));
 * }</pre>
 *
 * <p>Deliberately thin: every decision lives in the client, so callers who would rather not
 * depend on OpenFeature get identical evaluation semantics from {@link SwitchboardClient}
 * directly. This class is a translation layer and nothing else.
 */
public final class SwitchboardProvider implements FeatureProvider {

    private static final String NAME = "switchboard";

    private final SwitchboardClient client;
    private final boolean ownsClient;
    private final Metadata metadata;

    public SwitchboardProvider(SwitchboardConfig config) {
        this(new SwitchboardClient(config), true);
    }

    /** Wraps a client the caller owns; {@link #shutdown()} will not close it. */
    public SwitchboardProvider(SwitchboardClient client) {
        this(client, false);
    }

    private SwitchboardProvider(SwitchboardClient client, boolean ownsClient) {
        this.client = client;
        this.ownsClient = ownsClient;
        this.metadata = () -> NAME;
    }

    /** The underlying client, for {@code allFlags}, readiness and staleness. */
    public SwitchboardClient switchboard() {
        return client;
    }

    @Override
    public Metadata getMetadata() {
        return metadata;
    }

    @Override
    public void initialize(EvaluationContext context) {
        client.start();
    }

    @Override
    public void shutdown() {
        if (ownsClient) {
            client.close();
        }
    }

    /**
     * NOT_READY until a payload has landed. Reporting READY before then would tell the
     * OpenFeature runtime that defaults being served are real answers.
     */
    @Override
    public ProviderState getState() {
        return client.isReady() ? ProviderState.READY : ProviderState.NOT_READY;
    }

    // ------------------------------------------------------------------ evaluation

    @Override
    public ProviderEvaluation<Boolean> getBooleanEvaluation(String key, Boolean fallback, EvaluationContext ctx) {
        return toProviderEvaluation(client.booleanValue(key, Boolean.TRUE.equals(fallback), toEvalContext(ctx)));
    }

    @Override
    public ProviderEvaluation<String> getStringEvaluation(String key, String fallback, EvaluationContext ctx) {
        return toProviderEvaluation(client.stringValue(key, fallback, toEvalContext(ctx)));
    }

    @Override
    public ProviderEvaluation<Integer> getIntegerEvaluation(String key, Integer fallback, EvaluationContext ctx) {
        return toProviderEvaluation(client.integerValue(key, fallback == null ? 0 : fallback, toEvalContext(ctx)));
    }

    @Override
    public ProviderEvaluation<Double> getDoubleEvaluation(String key, Double fallback, EvaluationContext ctx) {
        return toProviderEvaluation(client.doubleValue(key, fallback == null ? 0d : fallback, toEvalContext(ctx)));
    }

    @Override
    public ProviderEvaluation<Value> getObjectEvaluation(String key, Value fallback, EvaluationContext ctx) {
        EvaluationDetail<JsonNode> detail = client.jsonValue(key, null, toEvalContext(ctx));
        Value value = detail.value() == null ? fallback : toValue(detail.value());
        return ProviderEvaluation.<Value>builder()
            .value(value)
            .reason(reasonOf(detail))
            .errorCode(errorCodeOf(detail))
            .errorMessage(detail.errorMessage())
            .flagMetadata(metadataOf(detail))
            .build();
    }

    private <T> ProviderEvaluation<T> toProviderEvaluation(EvaluationDetail<T> detail) {
        return ProviderEvaluation.<T>builder()
            .value(detail.value())
            .reason(reasonOf(detail))
            .errorCode(errorCodeOf(detail))
            .errorMessage(detail.errorMessage())
            .flagMetadata(metadataOf(detail))
            .build();
    }

    /**
     * Switchboard's reasons onto OpenFeature's. The mapping is lossy in one direction only:
     * KILL_SWITCH and FLAG_OFF both become DISABLED, TARGET_MATCH and RULE_MATCH both become
     * TARGETING_MATCH. Nothing is actually lost, because the precise reason is preserved in
     * flag metadata below - and the dashboard and audit trail depend on that distinction.
     */
    private static String reasonOf(EvaluationDetail<?> detail) {
        if (detail.isError()) {
            return Reason.ERROR.name();
        }
        EvalReason reason = detail.reason();
        if (reason == null) {
            return Reason.UNKNOWN.name();
        }
        return switch (reason) {
            case KILL_SWITCH, FLAG_OFF -> Reason.DISABLED.name();
            case TARGET_MATCH, RULE_MATCH -> Reason.TARGETING_MATCH.name();
            case ROLLOUT -> Reason.SPLIT.name();
            case DEFAULT, SDK_DEFAULT -> Reason.DEFAULT.name();
        };
    }

    private static ErrorCode errorCodeOf(EvaluationDetail<?> detail) {
        if (!detail.isError()) {
            return null;
        }
        return switch (detail.errorKind()) {
            case FLAG_NOT_FOUND -> ErrorCode.FLAG_NOT_FOUND;
            case PARSE_ERROR -> ErrorCode.PARSE_ERROR;
            case INVALID_CONTEXT -> ErrorCode.TARGETING_KEY_MISSING;
            case CLIENT_NOT_READY -> ErrorCode.PROVIDER_NOT_READY;
        };
    }

    /** Carries the un-flattened Switchboard reason and the ids behind the decision. */
    private static ImmutableMetadata metadataOf(EvaluationDetail<?> detail) {
        ImmutableMetadata.ImmutableMetadataBuilder builder = ImmutableMetadata.builder();
        if (detail.reason() != null) {
            builder.addString("switchboardReason", detail.reason().name());
        }
        if (detail.variationId() != null) {
            builder.addString("variationId", detail.variationId().toString());
        }
        if (detail.ruleId() != null) {
            builder.addString("ruleId", detail.ruleId().toString());
        }
        return builder.build();
    }

    // ------------------------------------------------------------------ context

    /**
     * OpenFeature's context to Switchboard's, preserving types.
     *
     * <p>The targeting key becomes the bucketing key. Nested structures are skipped rather
     * than stringified: no clause could use the result, and a stringified object would only
     * ever produce confusing near-misses.
     */
    static EvalContext toEvalContext(EvaluationContext ctx) {
        // EvalContext REFUSES a blank key by construction, which is right for the server -
        // it validates at the API boundary and a missing key there is a bad request. In an
        // SDK it is a landmine: this code runs inside the caller's process, OpenFeature
        // routinely hands over a context with no targeting key, and throwing here would turn
        // "no targeting key" into an exception thrown through the caller's flag check. Null
        // instead, which the client reports as INVALID_CONTEXT while still serving the
        // caller's default.
        if (ctx == null || ctx.getTargetingKey() == null || ctx.getTargetingKey().isBlank()) {
            return null;
        }
        Map<String, AttributeValue> attributes = new LinkedHashMap<>();
        Map<String, Value> raw = ctx.asUnmodifiableMap();
        for (Map.Entry<String, Value> entry : raw.entrySet()) {
            if (EvaluationContext.TARGETING_KEY.equals(entry.getKey())) {
                continue;
            }
            AttributeValue value = toAttribute(entry.getValue());
            if (value != null) {
                attributes.put(entry.getKey(), value);
            }
        }
        return new EvalContext(ctx.getTargetingKey(), Map.copyOf(attributes));
    }

    private static AttributeValue toAttribute(Value value) {
        if (value == null || value.isNull()) {
            return null;
        }
        if (value.isBoolean()) {
            return new AttributeValue.Bool(value.asBoolean());
        }
        if (value.isNumber()) {
            return new AttributeValue.Num(value.asDouble());
        }
        if (value.isString()) {
            return new AttributeValue.Str(value.asString());
        }
        // An Instant is a point in time and BEFORE/AFTER read ISO-8601, so this is the one
        // coercion that is genuinely lossless in the direction the operators care about.
        if (value.isInstant()) {
            return new AttributeValue.Str(value.asInstant().toString());
        }
        if (value.isList()) {
            List<AttributeValue> values = new ArrayList<>();
            for (Value element : value.asList()) {
                AttributeValue converted = toAttribute(element);
                if (converted != null) {
                    values.add(converted);
                }
            }
            return new AttributeValue.Arr(List.copyOf(values));
        }
        return null;
    }

    /**
     * A JSON variation value as an OpenFeature {@link Value}.
     *
     * <p>Goes via plain Java rather than building {@link Value}s directly: {@code Structure}
     * is defined over {@code Map<String, Object>}, so converting to ordinary maps and lists
     * and handing the result to {@link Value#objectToValue} keeps one conversion instead of
     * two that have to agree.
     */
    private static Value toValue(JsonNode node) {
        return Value.objectToValue(toPlainJava(node));
    }

    private static Object toPlainJava(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isBoolean()) {
            return node.asBoolean();
        }
        if (node.isNumber()) {
            return node.asDouble();
        }
        if (node.isTextual()) {
            return node.asText();
        }
        if (node.isArray()) {
            List<Object> values = new ArrayList<>();
            node.forEach(child -> values.add(toPlainJava(child)));
            return values;
        }
        if (node.isObject()) {
            Map<String, Object> fields = new LinkedHashMap<>();
            node.properties().forEach(e -> fields.put(e.getKey(), toPlainJava(e.getValue())));
            return fields;
        }
        return null;
    }
}
