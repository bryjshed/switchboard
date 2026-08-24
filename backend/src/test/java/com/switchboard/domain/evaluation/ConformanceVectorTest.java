package com.switchboard.domain.evaluation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Executes the cross-language conformance vectors in {@code spec/conformance/*.json} against the
 * reference implementation. This is what makes the vectors authoritative rather than aspirational:
 * an SDK in any language runs the same files and must produce the same answers.
 *
 * <p>A behaviour change to {@link FlagEvaluator} that is not reflected in the vectors fails here.
 * See {@code spec/README.md} for the rule that binds them together.
 */
class ConformanceVectorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path CONFORMANCE_DIR = locateConformanceDir();

    /** Walks up from the working directory so the test runs from the module or the repo root. */
    private static Path locateConformanceDir() {
        Path candidate = Path.of("").toAbsolutePath();
        for (int depth = 0; depth < 5 && candidate != null; depth++) {
            Path spec = candidate.resolve("spec").resolve("conformance");
            if (Files.isDirectory(spec)) {
                return spec;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("spec/conformance not found above " + Path.of("").toAbsolutePath());
    }

    private static List<Path> vectorFiles() {
        try (Stream<Path> files = Files.list(CONFORMANCE_DIR)) {
            return files.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static JsonNode read(Path file) {
        try {
            return MAPPER.readTree(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ------------------------------------------------ the vector runner

    @TestFactory
    Stream<DynamicTest> conformanceVectors() {
        List<DynamicTest> tests = new ArrayList<>();
        for (Path file : vectorFiles()) {
            JsonNode doc = read(file);
            String kind = doc.path("kind").asText();
            String prefix = file.getFileName().toString() + ": ";
            if ("bucket".equals(kind)) {
                for (JsonNode vector : doc.path("bucketVectors")) {
                    tests.add(DynamicTest.dynamicTest(prefix + vector.path("input").asText(),
                        () -> assertBucketVector(vector)));
                }
            } else if ("evaluation".equals(kind)) {
                Map<String, Flag> flags = new LinkedHashMap<>();
                Map<String, FlagEnvConfig> configs = new LinkedHashMap<>();
                loadFlags(doc, flags, configs);
                Map<String, Segment> segments = loadSegments(doc);
                for (JsonNode testCase : doc.path("cases")) {
                    tests.add(DynamicTest.dynamicTest(prefix + testCase.path("name").asText(),
                        () -> assertEvaluationCase(testCase, flags, configs, segments)));
                }
            } else if ("rollout-validation".equals(kind)) {
                for (JsonNode entry : doc.path("rolloutValidation")) {
                    tests.add(DynamicTest.dynamicTest(prefix + entry.path("name").asText(),
                        () -> assertRolloutValidation(entry)));
                }
            } else {
                tests.add(DynamicTest.dynamicTest(prefix + "unknown kind",
                    () -> fail("unrecognised vector kind '" + kind + "' in " + file)));
            }
        }
        assertFalse(tests.isEmpty(), "no conformance vectors were loaded from " + CONFORMANCE_DIR);
        return tests.stream();
    }

    private static void assertBucketVector(JsonNode vector) {
        String flagKey = vector.path("flagKey").asText();
        String contextKey = vector.path("contextKey").asText();
        assertEquals(flagKey + ":" + contextKey, vector.path("input").asText(), "vector input is inconsistent");
        assertEquals(vector.path("md5Hex").asText(), md5Hex(flagKey + ":" + contextKey), "md5 digest");
        assertEquals(vector.path("prefixHex").asText(), vector.path("md5Hex").asText().substring(0, 8),
            "prefixHex must be the first 8 hex characters of the digest");
        assertEquals(vector.path("prefixInt").asLong(), Long.parseLong(vector.path("prefixHex").asText(), 16),
            "prefixInt must be prefixHex read as an unsigned 32-bit big-endian integer");
        assertEquals(vector.path("prefixInt").asLong() % FlagEvaluator.BUCKET_SPACE,
            vector.path("bucket").asInt(), "bucket must be prefixInt mod BUCKET_SPACE");
        assertEquals(vector.path("bucket").asInt(), FlagEvaluator.bucket(flagKey, contextKey));
    }

    private static void assertEvaluationCase(
        JsonNode testCase, Map<String, Flag> flags, Map<String, FlagEnvConfig> configs,
        Map<String, Segment> segments) {

        String flagKey = testCase.path("flagKey").asText();
        EvalContext context = toContext(testCase.path("context"));
        JsonNode expected = testCase.path("expected");
        Flag flag = flags.get(flagKey);

        if (flag == null) {
            // The SDK fail-safe: an unknown flag serves the caller's default, it never errors.
            String fallback = testCase.hasNonNull("default") ? testCase.path("default").asText() : "";
            assertEquals(EvalReason.SDK_DEFAULT.name(), expected.path("reason").asText(),
                "a flag absent from the vector file can only produce SDK_DEFAULT");
            assertEquals(expected.path("value").asText(), fallback);
            return;
        }

        EvalOutcome outcome = FlagEvaluator.evaluate(flag, configs.get(flagKey), context, segments);
        assertEquals(expected.path("value").asText(), outcome.value(), "value");
        assertEquals(expected.path("reason").asText(), outcome.reason().name(), "reason");
        if (expected.hasNonNull("ruleId")) {
            assertEquals(UUID.fromString(expected.path("ruleId").asText()), outcome.ruleId(), "ruleId");
        } else {
            assertEquals(null, outcome.ruleId(), "ruleId must be absent unless the reason is RULE_MATCH");
        }
    }

    private static void assertRolloutValidation(JsonNode entry) {
        List<Integer> weights = new ArrayList<>();
        entry.path("weights").forEach(w -> weights.add(w.asInt()));
        if (entry.path("valid").asBoolean()) {
            RolloutOrVariation serve = RolloutOrVariation.ofRollout(weighted(weights));
            assertTrue(serve.hasRollout());
            assertEquals(100, serve.rollout().stream().mapToInt(WeightedVariation::weight).sum());
        } else {
            assertThrows(IllegalArgumentException.class,
                () -> RolloutOrVariation.ofRollout(weighted(weights)),
                "weights " + weights + " must be rejected (" + entry.path("reason").asText() + ")");
        }
    }

    private static List<WeightedVariation> weighted(List<Integer> weights) {
        List<WeightedVariation> rollout = new ArrayList<>();
        for (Integer weight : weights) {
            rollout.add(new WeightedVariation(UUID.randomUUID(), weight));
        }
        return rollout;
    }

    // ------------------------------------------------ cross-file invariant

    /**
     * ramp-at-10.json and ramp-at-25.json describe the SAME flag key over the SAME context keys at
     * two rollout percentages. Raising a ramp must only ever ADMIT contexts, never evict one.
     */
    @Test
    void rampingAFlagOnlyEverAdmitsContexts() {
        Set<String> inAtTen = rampMembers("ramp-at-10.json");
        Set<String> inAtTwentyFive = rampMembers("ramp-at-25.json");
        assertFalse(inAtTen.isEmpty(), "the 10% ramp vectors should include at least one context");
        assertTrue(inAtTwentyFive.containsAll(inAtTen), "ramping 10% -> 25% evicted " + inAtTen);
        assertTrue(inAtTwentyFive.size() > inAtTen.size(), "ramping 10% -> 25% should admit new contexts");
    }

    private static Set<String> rampMembers(String fileName) {
        JsonNode doc = read(CONFORMANCE_DIR.resolve(fileName));
        String served = doc.path("rampGroup").path("trueVariationValue").asText();
        Set<String> members = new HashSet<>();
        for (JsonNode testCase : doc.path("cases")) {
            if (served.equals(testCase.path("expected").path("value").asText())) {
                members.add(testCase.path("context").path("key").asText());
            }
        }
        return members;
    }

    // ------------------------------------------------ JSON -> domain

    private static void loadFlags(JsonNode doc, Map<String, Flag> flags, Map<String, FlagEnvConfig> configs) {
        for (JsonNode node : doc.path("flags")) {
            String key = node.path("key").asText();
            List<Variation> variations = new ArrayList<>();
            for (JsonNode variation : node.path("variations")) {
                variations.add(new Variation(
                    UUID.fromString(variation.path("id").asText()),
                    variation.path("value").asText(),
                    variation.path("name").asText(null)));
            }
            UUID flagId = UUID.randomUUID();
            flags.put(key, new Flag(flagId, UUID.randomUUID(), key, node.path("name").asText(key), null,
                FlagKind.valueOf(node.path("kind").asText()), variations, List.of(), false));
            configs.put(key, new FlagEnvConfig(flagId, UUID.randomUUID(),
                node.path("enabled").asBoolean(), node.path("killSwitchActive").asBoolean(),
                toTargeting(node.path("targeting")), 1, null, "conformance"));
        }
    }

    private static Map<String, Segment> loadSegments(JsonNode doc) {
        Map<String, Segment> segments = new HashMap<>();
        for (JsonNode node : doc.path("segments")) {
            String key = node.path("key").asText();
            List<SegmentRule> rules = new ArrayList<>();
            for (JsonNode rule : node.path("rules")) {
                rules.add(new SegmentRule(toClauses(rule.path("clauses"))));
            }
            segments.put(key, new Segment(UUID.randomUUID(), UUID.randomUUID(), key,
                node.path("name").asText(key), toStrings(node.path("includedKeys")),
                toStrings(node.path("excludedKeys")), rules, null));
        }
        return segments;
    }

    private static TargetingConfig toTargeting(JsonNode node) {
        List<IndividualTarget> targets = new ArrayList<>();
        for (JsonNode target : node.path("individualTargets")) {
            targets.add(new IndividualTarget(target.path("contextKey").asText(),
                UUID.fromString(target.path("variationId").asText())));
        }
        List<Rule> rules = new ArrayList<>();
        for (JsonNode rule : node.path("rules")) {
            rules.add(new Rule(UUID.fromString(rule.path("id").asText()),
                rule.path("description").asText(null), toClauses(rule.path("clauses")),
                toServe(rule.path("serve"))));
        }
        return new TargetingConfig(targets, rules, toServe(node.path("fallthrough")),
            UUID.fromString(node.path("offVariationId").asText()),
            UUID.fromString(node.path("defaultVariationId").asText()));
    }

    private static RolloutOrVariation toServe(JsonNode node) {
        if (node.hasNonNull("rollout")) {
            List<WeightedVariation> rollout = new ArrayList<>();
            for (JsonNode weighted : node.path("rollout")) {
                rollout.add(new WeightedVariation(
                    UUID.fromString(weighted.path("variationId").asText()), weighted.path("weight").asInt()));
            }
            return RolloutOrVariation.ofRollout(rollout);
        }
        return RolloutOrVariation.ofVariation(UUID.fromString(node.path("variationId").asText()));
    }

    private static List<Clause> toClauses(JsonNode node) {
        List<Clause> clauses = new ArrayList<>();
        for (JsonNode clause : node) {
            clauses.add(new Clause(clause.path("attribute").asText(),
                ClauseOp.valueOf(clause.path("op").asText()), toStrings(clause.path("values"))));
        }
        return clauses;
    }

    private static List<String> toStrings(JsonNode node) {
        List<String> values = new ArrayList<>();
        node.forEach(value -> values.add(value.asText()));
        return values;
    }

    private static EvalContext toContext(JsonNode node) {
        Map<String, String> attributes = new HashMap<>();
        node.path("attributes").properties()
            .forEach(entry -> attributes.put(entry.getKey(), entry.getValue().asText()));
        return new EvalContext(node.path("key").asText(), attributes);
    }

    private static String md5Hex(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("MD5").digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
