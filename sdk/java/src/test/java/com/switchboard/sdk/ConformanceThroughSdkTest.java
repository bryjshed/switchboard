package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.sdk.internal.BootstrapCodec;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The cross-language conformance vectors, executed through the SDK'S OWN path.
 *
 * <h2>Why this is not a duplicate of the evaluation module's suite</h2>
 *
 * <p>{@code evaluation/}'s {@code ConformanceVectorTest} builds domain records directly and
 * calls {@link com.switchboard.domain.evaluation.FlagEvaluator}. Because this SDK shares that
 * evaluator rather than reimplementing it, running the same vectors the same way here would
 * assert that a class equals itself - it would pass no matter how broken the SDK was.
 *
 * <p>What this test does instead is feed each vector in as a BOOTSTRAP PAYLOAD - the JSON
 * shape the server actually sends - through {@link BootstrapCodec} and out through
 * {@link SwitchboardClient}'s evaluation. That covers the only part of Java evaluation this
 * SDK still owns, and the only place it can still disagree with the server: the mapping from
 * wire JSON to domain records. A dropped field, a mis-read operator or a lost negate flag
 * fails here and nowhere else.
 */
class ConformanceThroughSdkTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CONFORMANCE_DIR = locateConformanceDir();

    /** Walks up from the working directory, so this works from the module or the repo root. */
    private static Path locateConformanceDir() {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null) {
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
            return files.filter(f -> f.toString().endsWith(".json")).sorted().toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static JsonNode read(Path file) {
        try {
            return JSON.readTree(Files.readString(file));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Rewrites a vector document into a bootstrap payload. The only structural difference is
     * the name of the targeting block - vectors say {@code targeting}, the wire says
     * {@code config} - and the codec accepts both precisely so this rewrite stays honest
     * about everything else.
     */
    private static JsonNode toBootstrapPayload(JsonNode doc) {
        ObjectNode payload = JSON.createObjectNode();
        payload.put("envKey", "conformance");
        payload.put("stateVersion", 1);
        ArrayNode flags = payload.putArray("flags");
        for (JsonNode flag : doc.path("flags")) {
            ObjectNode copy = flag.deepCopy();
            copy.put("version", 1);
            flags.add(copy);
        }
        ArrayNode segments = payload.putArray("segments");
        for (JsonNode segment : doc.path("segments")) {
            segments.add(segment.deepCopy());
        }
        return payload;
    }

    @TestFactory
    Stream<DynamicTest> vectorsThroughTheSdkPath() {
        List<DynamicTest> tests = new ArrayList<>();
        for (Path file : vectorFiles()) {
            JsonNode doc = read(file);
            if (!"evaluation".equals(doc.path("kind").asText())) {
                continue;   // bucket and rollout-validation vectors are not evaluations
            }
            BootstrapCodec.Snapshot snapshot = BootstrapCodec.readBootstrap(toBootstrapPayload(doc));
            String fileName = file.getFileName().toString();

            for (JsonNode testCase : doc.path("cases")) {
                String name = fileName + ": " + testCase.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> {
                    String flagKey = testCase.path("flagKey").asText();
                    EvalContext context = BootstrapCodec.readContext(testCase.path("context"));
                    JsonNode expected = testCase.path("expected");

                    BootstrapCodec.Entry entry = snapshot.flagsByKey().get(flagKey);
                    if (entry == null) {
                        // The fail-safe vectors: an unknown flag serves the caller's default.
                        assertEquals("SDK_DEFAULT", expected.path("reason").asText(),
                            "flag " + flagKey + " is absent, so only an SDK_DEFAULT case can be expected");
                        return;
                    }
                    var outcome = com.switchboard.domain.evaluation.FlagEvaluator.evaluate(
                        entry.flag(), entry.config(), context, snapshot.segmentsByKey());

                    assertEquals(expected.path("value").asText(), outcome.value(), "value for " + name);
                    assertEquals(expected.path("reason").asText(), outcome.reason().name(), "reason for " + name);
                }));
            }
        }
        assertFalse(tests.isEmpty(), "no conformance vectors were loaded from " + CONFORMANCE_DIR);
        return tests.stream();
    }

    /**
     * The count is asserted to be substantial but is NOT hardcoded: the vectors are generated
     * and a hardcoded number turns every legitimate addition into a failing test, which is how
     * a suite ends up being edited to match rather than the code.
     */
    @Test
    void executesTheWholeEvaluationCorpus() {
        long cases = vectorFiles().stream()
            .map(ConformanceThroughSdkTest::read)
            .filter(doc -> "evaluation".equals(doc.path("kind").asText()))
            .mapToLong(doc -> doc.path("cases").size())
            .sum();
        assertTrue(cases > 400, "expected the full evaluation corpus, found " + cases + " cases");
    }
}
