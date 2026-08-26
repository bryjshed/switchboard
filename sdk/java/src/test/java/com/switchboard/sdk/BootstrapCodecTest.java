package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.evaluation.AttributeValue;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.flag.ClauseOp;
import com.switchboard.sdk.internal.BootstrapCodec;
import org.junit.jupiter.api.Test;

/**
 * The wire-to-domain mapping. This is the only Java code left that can disagree with the
 * server about evaluation, so the cases here are the ones the conformance vectors cannot
 * reach: malformed payloads, forward compatibility, and type preservation.
 */
class BootstrapCodecTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode json(String raw) {
        try {
            return JSON.readTree(raw);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void aRuleWithAnUnknownOperatorIsDroppedNotApproximated() {
        // A newer server ships a new operator; a deployed older SDK must not guess. Clauses
        // are ANDed, so a rule that cannot be fully understood can never be safely matched.
        JsonNode payload = json("""
            {"envKey":"p","stateVersion":1,"segments":[],"flags":[{
              "key":"f","kind":"BOOLEAN","enabled":true,"killSwitchActive":false,"version":1,
              "variations":[{"id":"0a0a0a0a-0000-4000-8000-000000000001","value":"true"}],
              "config":{"individualTargets":[],"rules":[
                 {"id":"0c0c0c0c-0000-4000-8000-000000000001",
                  "clauses":[{"attribute":"x","op":"OPERATOR_FROM_THE_FUTURE","values":["1"]}],
                  "serve":{"variationId":"0a0a0a0a-0000-4000-8000-000000000001"}},
                 {"id":"0c0c0c0c-0000-4000-8000-000000000002",
                  "clauses":[{"attribute":"plan","op":"EQUALS","values":["pro"]}],
                  "serve":{"variationId":"0a0a0a0a-0000-4000-8000-000000000001"}}],
                 "fallthrough":{"variationId":"0a0a0a0a-0000-4000-8000-000000000001"},
                 "offVariationId":"0a0a0a0a-0000-4000-8000-000000000001",
                 "defaultVariationId":"0a0a0a0a-0000-4000-8000-000000000001"}}]}
            """);
        var entry = BootstrapCodec.readBootstrap(payload).flagsByKey().get("f");
        assertEquals(1, entry.config().config().rules().size(), "the unreadable rule should be gone");
        assertEquals(ClauseOp.EQUALS, entry.config().config().rules().getFirst().clauses().getFirst().op());
    }

    @Test
    void deprecatedNotSegmentMatchIsNormalisedToSegmentMatchPlusNegate() {
        // Configs written before per-clause negation existed must evaluate identically.
        JsonNode payload = json("""
            {"envKey":"p","stateVersion":1,"segments":[],"flags":[{
              "key":"f","kind":"BOOLEAN","enabled":true,"killSwitchActive":false,"version":1,
              "variations":[{"id":"0a0a0a0a-0000-4000-8000-000000000001","value":"true"}],
              "config":{"individualTargets":[],"rules":[
                 {"id":"0c0c0c0c-0000-4000-8000-000000000001",
                  "clauses":[{"attribute":"key","op":"NOT_SEGMENT_MATCH","values":["beta"]}],
                  "serve":{"variationId":"0a0a0a0a-0000-4000-8000-000000000001"}}],
                 "fallthrough":{"variationId":"0a0a0a0a-0000-4000-8000-000000000001"},
                 "offVariationId":"0a0a0a0a-0000-4000-8000-000000000001",
                 "defaultVariationId":"0a0a0a0a-0000-4000-8000-000000000001"}}]}
            """);
        var clause = BootstrapCodec.readBootstrap(payload)
            .flagsByKey().get("f").config().config().rules().getFirst().clauses().getFirst();
        assertEquals(ClauseOp.SEGMENT_MATCH, clause.op());
        assertTrue(clause.negate(), "NOT_SEGMENT_MATCH must become SEGMENT_MATCH + negate");
    }

    @Test
    void contextAttributeTypesArePreservedNotStringified() {
        // The operator decides how to read both sides, so a number arriving as a string
        // would silently change what GREATER_THAN and SEMVER_* mean.
        EvalContext context = BootstrapCodec.readContext(json("""
            {"key":"user-1","attributes":{"seats":250,"beta":true,"plan":"pro","tags":["a","b"]}}
            """));
        assertEquals("user-1", context.key());
        assertInstanceOf(AttributeValue.Num.class, context.attributes().get("seats"));
        assertInstanceOf(AttributeValue.Bool.class, context.attributes().get("beta"));
        assertInstanceOf(AttributeValue.Str.class, context.attributes().get("plan"));
        assertInstanceOf(AttributeValue.Arr.class, context.attributes().get("tags"));
    }

    @Test
    void nestedObjectAttributesAreSkippedRatherThanCoerced() {
        EvalContext context = BootstrapCodec.readContext(json("""
            {"key":"u","attributes":{"nested":{"a":1},"flat":"kept"}}
            """));
        assertTrue(context.attributes().containsKey("flat"));
        assertTrue(!context.attributes().containsKey("nested"), "no clause could use a stringified object");
    }

    @Test
    void missingCollectionsReadAsEmptyRatherThanThrowing() {
        // Forward compatibility: a payload missing a field this version expects must not
        // take the host application down.
        var snapshot = BootstrapCodec.readBootstrap(json("{\"envKey\":\"p\",\"stateVersion\":3}"));
        assertEquals(3L, snapshot.stateVersion());
        assertTrue(snapshot.flagsByKey().isEmpty());
        assertTrue(snapshot.segmentsByKey().isEmpty());
    }

    @Test
    void aPayloadThatIsNotAnObjectIsARealError() {
        // This one is not forward compatibility - it means auth or transport is broken, and
        // silently treating it as "no flags" would serve defaults forever with nothing said.
        assertThrows(IllegalArgumentException.class, () -> BootstrapCodec.readBootstrap(json("[]")));
    }

    @Test
    void anEmptyRolloutArrayAlongsideAVariationIdIsAVariationServe() {
        // The exact shape a live server sends: the rollout field is PRESENT but empty when a
        // single variation is served. Treating presence as "is a rollout" made every real
        // bootstrap payload unparseable while every hand-written fixture - which omits the
        // field - parsed fine. Only the live check caught it, so the real shape lives here now.
        JsonNode payload = json("""
            {"envKey":"production","stateVersion":28,"segments":[],"flags":[{
              "key":"dark-mode","kind":"BOOLEAN","enabled":true,"killSwitchActive":false,"version":4,
              "variations":[{"id":"36f36c6e-c8b8-4378-aaaa-b85d5ed3ba6e","value":"true","name":"True"},
                            {"id":"bb2ee8c9-1644-45ee-a08f-78b6f8b2efaa","value":"false","name":"False"}],
              "config":{"fallthrough":{"rollout":[],"variationId":"36f36c6e-c8b8-4378-aaaa-b85d5ed3ba6e"},
                "offVariationId":"bb2ee8c9-1644-45ee-a08f-78b6f8b2efaa",
                "defaultVariationId":"36f36c6e-c8b8-4378-aaaa-b85d5ed3ba6e",
                "individualTargets":[],"rules":[]}}]}
            """);
        var fallthrough = BootstrapCodec.readBootstrap(payload)
            .flagsByKey().get("dark-mode").config().config().fallthrough();
        assertFalse(fallthrough.hasRollout(), "an empty rollout array is not a rollout");
        assertEquals("36f36c6e-c8b8-4378-aaaa-b85d5ed3ba6e", fallthrough.variationId().toString());
    }

    @Test
    void anEmptyRolloutInsideARuleServeIsAlsoAVariationServe() {
        JsonNode payload = json("""
            {"envKey":"production","stateVersion":1,"segments":[],"flags":[{
              "key":"pro","kind":"BOOLEAN","enabled":true,"killSwitchActive":false,"version":2,
              "variations":[{"id":"e68082e4-ccc9-4dde-a859-163454639890","value":"true"}],
              "config":{"individualTargets":[],"rules":[
                {"id":"396cab68-1657-4bde-991e-dfb3ce7ec9b2",
                 "clauses":[{"attribute":"plan","op":"EQUALS","values":["pro"],"negate":false}],
                 "serve":{"rollout":[],"variationId":"e68082e4-ccc9-4dde-a859-163454639890"}}],
                "fallthrough":{"rollout":[],"variationId":"e68082e4-ccc9-4dde-a859-163454639890"},
                "offVariationId":"e68082e4-ccc9-4dde-a859-163454639890",
                "defaultVariationId":"e68082e4-ccc9-4dde-a859-163454639890"}}]}
            """);
        var rule = BootstrapCodec.readBootstrap(payload)
            .flagsByKey().get("pro").config().config().rules().getFirst();
        assertFalse(rule.serve().hasRollout());
        assertEquals("e68082e4-ccc9-4dde-a859-163454639890", rule.serve().variationId().toString());
    }

    @Test
    void readsARolloutFallthrough() {
        JsonNode payload = json("""
            {"envKey":"p","stateVersion":1,"segments":[],"flags":[{
              "key":"f","kind":"BOOLEAN","enabled":true,"killSwitchActive":false,"version":1,
              "variations":[{"id":"0a0a0a0a-0000-4000-8000-000000000001","value":"true"},
                            {"id":"0a0a0a0a-0000-4000-8000-000000000002","value":"false"}],
              "config":{"individualTargets":[],"rules":[],
                 "fallthrough":{"rollout":[
                    {"variationId":"0a0a0a0a-0000-4000-8000-000000000001","weight":25},
                    {"variationId":"0a0a0a0a-0000-4000-8000-000000000002","weight":75}]},
                 "offVariationId":"0a0a0a0a-0000-4000-8000-000000000002",
                 "defaultVariationId":"0a0a0a0a-0000-4000-8000-000000000001"}}]}
            """);
        var fallthrough = BootstrapCodec.readBootstrap(payload)
            .flagsByKey().get("f").config().config().fallthrough();
        assertTrue(fallthrough.hasRollout());
        assertEquals(25, fallthrough.rollout().getFirst().weight());
    }
}
