package com.switchboard.sdk.internal;

import com.fasterxml.jackson.databind.JsonNode;
import com.switchboard.domain.evaluation.AttributeValue;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.flag.Clause;
import com.switchboard.domain.flag.ClauseOp;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.domain.flag.IndividualTarget;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.Rule;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.flag.WeightedVariation;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRule;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Turns the bootstrap wire format into the evaluation core's types.
 *
 * <p>This class is the whole reason a Java SDK can share the server's evaluator rather than
 * reimplement it: the shared module speaks in domain records, the API speaks JSON, and
 * exactly one mapping stands between them. It is also therefore the only place a Java SDK
 * can still disagree with the server, which is why the conformance vectors are run through
 * <em>this</em> path in tests rather than against {@code FlagEvaluator} directly - the
 * evaluator is already covered by the evaluation module's own suite, and re-testing it here
 * would prove nothing about the SDK.
 *
 * <h2>Missing fields are absent, not fatal</h2>
 *
 * <p>A flag SDK that throws on an unrecognised payload takes the application down with it,
 * which is worse than the outage it was meant to survive. Unknown properties are ignored and
 * absent collections read as empty, so a server that adds a field does not break a deployed
 * SDK. The one exception is a payload that is not an object at all, which is a real transport
 * or authentication problem and is surfaced.
 */
public final class BootstrapCodec {

    private BootstrapCodec() {
    }

    /** One environment's evaluable state, as the client holds it. */
    public record Snapshot(
        String envKey,
        long stateVersion,
        Map<String, Entry> flagsByKey,
        Map<String, Segment> segmentsByKey) {

        public static Snapshot empty() {
            return new Snapshot("", 0L, Map.of(), Map.of());
        }
    }

    /** A flag and the environment config it is evaluated against - the evaluator wants both. */
    public record Entry(Flag flag, FlagEnvConfig config) {
    }

    /**
     * Reads a {@code BootstrapResponse}. The wire calls the targeting block {@code config};
     * the conformance vectors call the same block {@code targeting}, so both are accepted and
     * the vectors can be replayed through this exact code path.
     */
    public static Snapshot readBootstrap(JsonNode root) {
        if (root == null || !root.isObject()) {
            throw new IllegalArgumentException("bootstrap payload is not a JSON object");
        }
        Map<String, Entry> flags = new LinkedHashMap<>();
        for (JsonNode node : array(root, "flags")) {
            Entry entry = readFlag(node);
            flags.put(entry.flag().key(), entry);
        }
        Map<String, Segment> segments = new LinkedHashMap<>();
        for (JsonNode node : array(root, "segments")) {
            Segment segment = readSegment(node);
            segments.put(segment.key(), segment);
        }
        return new Snapshot(
            text(root, "envKey", ""),
            root.path("stateVersion").asLong(0L),
            Map.copyOf(flags),
            Map.copyOf(segments));
    }

    /** One flag, as it appears in a bootstrap payload or in a {@code patch} stream event. */
    public static Entry readFlag(JsonNode node) {
        List<Variation> variations = new ArrayList<>();
        for (JsonNode v : array(node, "variations")) {
            variations.add(new Variation(uuid(v, "id"), text(v, "value", ""), text(v, "name", null)));
        }
        String key = text(node, "key", "");
        Flag flag = new Flag(
            uuid(node, "id"),
            null,
            key,
            text(node, "name", key),
            text(node, "description", null),
            kind(text(node, "kind", "BOOLEAN")),
            List.copyOf(variations),
            List.of(),
            false,
            node.path("clientSideAvailable").asBoolean(false));

        JsonNode targeting = node.has("config") ? node.get("config") : node.path("targeting");
        FlagEnvConfig config = new FlagEnvConfig(
            flag.id(),
            null,
            node.path("enabled").asBoolean(false),
            node.path("killSwitchActive").asBoolean(false),
            readTargeting(targeting),
            node.path("version").asInt(1),
            null,
            null);
        return new Entry(flag, config);
    }

    private static TargetingConfig readTargeting(JsonNode node) {
        List<IndividualTarget> targets = new ArrayList<>();
        for (JsonNode t : array(node, "individualTargets")) {
            targets.add(new IndividualTarget(text(t, "contextKey", ""), uuid(t, "variationId")));
        }
        List<Rule> rules = new ArrayList<>();
        for (JsonNode r : array(node, "rules")) {
            List<Clause> clauses = readClauses(r);
            // A rule carrying an operator this SDK version does not know is DROPPED, not
            // approximated. Clauses are ANDed, so a rule that cannot be fully understood can
            // never be safely said to match; dropping it is the same outcome and says so.
            if (clauses == null) {
                continue;
            }
            rules.add(new Rule(
                uuid(r, "id"),
                text(r, "description", null),
                clauses,
                readServe(r.path("serve"))));
        }
        return new TargetingConfig(
            List.copyOf(targets),
            List.copyOf(rules),
            readServe(node.path("fallthrough")),
            uuid(node, "offVariationId"),
            uuid(node, "defaultVariationId"));
    }

    /** Returns null if any clause uses an operator this version does not know. */
    private static List<Clause> readClauses(JsonNode parent) {
        List<Clause> clauses = new ArrayList<>();
        for (JsonNode c : array(parent, "clauses")) {
            ClauseOp op = op(text(c, "op", "EQUALS"));
            if (op == null) {
                return null;
            }
            List<String> values = new ArrayList<>();
            for (JsonNode v : array(c, "values")) {
                values.add(v.isNull() ? null : v.asText());
            }
            // normalised() folds the deprecated NOT_SEGMENT_MATCH into SEGMENT_MATCH + negate,
            // exactly as the server does at read time, so a config written before per-clause
            // negation existed evaluates identically here.
            clauses.add(new Clause(
                text(c, "attribute", ""),
                op,
                List.copyOf(values),
                c.path("negate").asBoolean(false)).normalised());
        }
        return List.copyOf(clauses);
    }

    private static RolloutOrVariation readServe(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return RolloutOrVariation.ofVariation(null);
        }
        // The EMPTY array matters. A live server serialises a single-variation serve as
        // {"rollout":[],"variationId":"..."} - the field is present but empty - while
        // RolloutOrVariation requires exactly one of the two to be set. Treating "present"
        // as "is a rollout" made every real bootstrap payload unparseable while every
        // hand-written test fixture, which omits the field entirely, parsed fine. Caught by
        // the live check against a seeded stack; pinned by a test using the real shape.
        if (node.has("rollout") && node.get("rollout").isArray() && !node.get("rollout").isEmpty()) {
            List<WeightedVariation> weights = new ArrayList<>();
            for (JsonNode w : node.get("rollout")) {
                weights.add(new WeightedVariation(uuid(w, "variationId"), w.path("weight").asInt(0)));
            }
            return RolloutOrVariation.ofRollout(List.copyOf(weights));
        }
        return RolloutOrVariation.ofVariation(uuid(node, "variationId"));
    }

    private static Segment readSegment(JsonNode node) {
        List<SegmentRule> rules = new ArrayList<>();
        for (JsonNode r : array(node, "rules")) {
            List<Clause> clauses = readClauses(r);
            // Same rule as targeting rules: a segment rule that cannot be fully read is
            // dropped rather than half-evaluated. Segment rules are ORed, so dropping one
            // narrows membership - the conservative direction for a cohort.
            if (clauses != null) {
                rules.add(new SegmentRule(clauses));
            }
        }
        return new Segment(
            uuid(node, "id"),
            null,
            text(node, "key", ""),
            text(node, "name", null),
            strings(node, "includedKeys"),
            strings(node, "excludedKeys"),
            List.copyOf(rules),
            null);
    }

    /**
     * Reads an evaluation context from JSON. Attribute types are preserved rather than
     * stringified: {@code appVersion} arriving as a JSON string and {@code seats} as a JSON
     * number are different things to a SEMVER or a GREATER_THAN clause.
     */
    public static EvalContext readContext(JsonNode node) {
        Map<String, AttributeValue> attributes = new LinkedHashMap<>();
        JsonNode attrs = node.path("attributes");
        if (attrs.isObject()) {
            attrs.properties().forEach(e -> {
                AttributeValue value = attribute(e.getValue());
                if (value != null) {
                    attributes.put(e.getKey(), value);
                }
            });
        }
        return new EvalContext(text(node, "key", ""), Map.copyOf(attributes));
    }

    /** Nested objects have no meaning to any clause, so they are skipped rather than coerced. */
    private static AttributeValue attribute(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (node.isBoolean()) {
            return new AttributeValue.Bool(node.asBoolean());
        }
        if (node.isNumber()) {
            return new AttributeValue.Num(node.asDouble());
        }
        if (node.isTextual()) {
            return new AttributeValue.Str(node.asText());
        }
        if (node.isArray()) {
            List<AttributeValue> values = new ArrayList<>();
            for (JsonNode element : node) {
                AttributeValue value = attribute(element);
                if (value != null) {
                    values.add(value);
                }
            }
            return new AttributeValue.Arr(List.copyOf(values));
        }
        return null;
    }

    // ------------------------------------------------------------------ helpers

    private static Iterable<JsonNode> array(JsonNode parent, String field) {
        JsonNode node = parent == null ? null : parent.path(field);
        return node != null && node.isArray() ? node : List.of();
    }

    private static List<String> strings(JsonNode parent, String field) {
        List<String> out = new ArrayList<>();
        for (JsonNode node : array(parent, field)) {
            out.add(node.asText());
        }
        return List.copyOf(out);
    }

    private static String text(JsonNode parent, String field, String fallback) {
        JsonNode node = parent == null ? null : parent.path(field);
        return node == null || node.isNull() || node.isMissingNode() ? fallback : node.asText();
    }

    private static UUID uuid(JsonNode parent, String field) {
        String raw = text(parent, field, null);
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * Null for an operator this SDK version does not know, which drops the enclosing rule.
     * A newer server adding an operator must not take an older SDK's process down, and must
     * not silently get a rule evaluated on partial understanding either.
     */
    private static ClauseOp op(String raw) {
        try {
            return ClauseOp.valueOf(raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static FlagKind kind(String raw) {
        try {
            return FlagKind.valueOf(raw);
        } catch (IllegalArgumentException e) {
            return FlagKind.STRING;
        }
    }
}
