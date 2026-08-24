package com.switchboard.domain.evaluation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class FlagEvaluatorTest {

    private static final UUID TRUE_ID = UUID.randomUUID();
    private static final UUID FALSE_ID = UUID.randomUUID();
    private static final UUID RULE_ID = UUID.randomUUID();
    private static final UUID ENV_ID = UUID.randomUUID();

    private static Flag booleanFlag() {
        return new Flag(UUID.randomUUID(), UUID.randomUUID(), "new-checkout", "New checkout", null,
            FlagKind.BOOLEAN,
            List.of(new Variation(TRUE_ID, "true", "True"), new Variation(FALSE_ID, "false", "False")),
            List.of(), false);
    }

    private static TargetingConfig config(
        List<IndividualTarget> targets, List<Rule> rules, RolloutOrVariation fallthrough) {
        return new TargetingConfig(targets, rules, fallthrough, FALSE_ID, TRUE_ID);
    }

    private static FlagEnvConfig env(boolean enabled, boolean killSwitch, TargetingConfig config) {
        return new FlagEnvConfig(UUID.randomUUID(), ENV_ID, enabled, killSwitch, config, 1, null, "t@ex.com");
    }

    private static EvalContext user(String key) {
        return new EvalContext(key, Map.of());
    }

    private static Rule matchAllRule(UUID serveVariation) {
        return new Rule(RULE_ID, null,
            List.of(new Clause("plan", ClauseOp.EQUALS, List.of("pro"))),
            RolloutOrVariation.ofVariation(serveVariation));
    }

    // ------------------------------------------------ precedence matrix

    @Test
    void killSwitchBeatsEverythingElse() {
        TargetingConfig config = config(
            List.of(new IndividualTarget("user-1", TRUE_ID)),
            List.of(matchAllRule(TRUE_ID)),
            RolloutOrVariation.ofVariation(TRUE_ID));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, true, config),
            new EvalContext("user-1", Map.of("plan", "pro")), Map.of());
        assertEquals(EvalReason.KILL_SWITCH, outcome.reason());
        assertEquals("false", outcome.value());
        assertNull(outcome.ruleId());
    }

    @Test
    void disabledBeatsTargetsRulesAndFallthrough() {
        TargetingConfig config = config(
            List.of(new IndividualTarget("user-1", TRUE_ID)),
            List.of(matchAllRule(TRUE_ID)),
            RolloutOrVariation.ofVariation(TRUE_ID));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(false, false, config),
            new EvalContext("user-1", Map.of("plan", "pro")), Map.of());
        assertEquals(EvalReason.FLAG_OFF, outcome.reason());
        assertEquals("false", outcome.value());
    }

    @Test
    void individualTargetBeatsRules() {
        TargetingConfig config = config(
            List.of(new IndividualTarget("user-1", FALSE_ID)),
            List.of(matchAllRule(TRUE_ID)),
            RolloutOrVariation.ofVariation(TRUE_ID));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("user-1", Map.of("plan", "pro")), Map.of());
        assertEquals(EvalReason.TARGET_MATCH, outcome.reason());
        assertEquals("false", outcome.value());
    }

    @Test
    void ruleBeatsFallthrough() {
        TargetingConfig config = config(
            List.of(),
            List.of(matchAllRule(FALSE_ID)),
            RolloutOrVariation.ofVariation(TRUE_ID));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("user-2", Map.of("plan", "pro")), Map.of());
        assertEquals(EvalReason.RULE_MATCH, outcome.reason());
        assertEquals(RULE_ID, outcome.ruleId());
        assertEquals("false", outcome.value());
    }

    @Test
    void firstMatchingRuleWins() {
        Rule second = new Rule(UUID.randomUUID(), null,
            List.of(new Clause("plan", ClauseOp.EQUALS, List.of("pro"))),
            RolloutOrVariation.ofVariation(TRUE_ID));
        TargetingConfig config = config(
            List.of(), List.of(matchAllRule(FALSE_ID), second), RolloutOrVariation.ofVariation(TRUE_ID));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("user-2", Map.of("plan", "pro")), Map.of());
        assertEquals(RULE_ID, outcome.ruleId());
    }

    @Test
    void fixedFallthroughIsDefaultReason() {
        TargetingConfig config = config(List.of(), List.of(), RolloutOrVariation.ofVariation(TRUE_ID));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-3"), Map.of());
        assertEquals(EvalReason.DEFAULT, outcome.reason());
        assertEquals("true", outcome.value());
    }

    @Test
    void rolloutFallthroughIsRolloutReason() {
        TargetingConfig config = config(List.of(), List.of(), rollout(50));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-3"), Map.of());
        assertEquals(EvalReason.ROLLOUT, outcome.reason());
        assertTrue(outcome.value().equals("true") || outcome.value().equals("false"));
    }

    @Test
    void multivariatePrecedenceHoldsToo() {
        UUID control = UUID.randomUUID();
        UUID compact = UUID.randomUUID();
        UUID expanded = UUID.randomUUID();
        Flag flag = new Flag(UUID.randomUUID(), UUID.randomUUID(), "planner-v2", "Planner", null,
            FlagKind.STRING,
            List.of(new Variation(control, "control", null), new Variation(compact, "compact", null),
                new Variation(expanded, "expanded", null)),
            List.of(), false);
        TargetingConfig config = new TargetingConfig(
            List.of(new IndividualTarget("user-1", expanded)),
            List.of(new Rule(RULE_ID, null,
                List.of(new Clause("plan", ClauseOp.EQUALS, List.of("pro"))),
                RolloutOrVariation.ofVariation(compact))),
            RolloutOrVariation.ofVariation(control), control, control);
        FlagEnvConfig envConfig = new FlagEnvConfig(flag.id(), ENV_ID, true, false, config, 1, null, "t");

        assertEquals("expanded", FlagEvaluator.evaluate(
            flag, envConfig, new EvalContext("user-1", Map.of("plan", "pro")), Map.of()).value());
        assertEquals("compact", FlagEvaluator.evaluate(
            flag, envConfig, new EvalContext("user-2", Map.of("plan", "pro")), Map.of()).value());
        assertEquals("control", FlagEvaluator.evaluate(
            flag, envConfig, user("user-3"), Map.of()).value());
    }

    // ------------------------------------------------ bucketing

    private static RolloutOrVariation rollout(int trueWeight) {
        return RolloutOrVariation.ofRollout(List.of(
            new WeightedVariation(TRUE_ID, trueWeight),
            new WeightedVariation(FALSE_ID, 100 - trueWeight)));
    }

    @Test
    void bucketingIsSticky() {
        Flag flag = booleanFlag();
        TargetingConfig config = config(List.of(), List.of(), rollout(25));
        FlagEnvConfig envConfig = env(true, false, config);
        for (int i = 0; i < 50; i++) {
            String first = FlagEvaluator.evaluate(flag, envConfig, user("user-" + i), Map.of()).value();
            for (int repeat = 0; repeat < 5; repeat++) {
                assertEquals(first, FlagEvaluator.evaluate(flag, envConfig, user("user-" + i), Map.of()).value());
            }
        }
    }

    @Test
    void rampUpKeepsEarlyUsers() {
        Flag flag = booleanFlag();
        FlagEnvConfig at10 = env(true, false, config(List.of(), List.of(), rollout(10)));
        FlagEnvConfig at25 = env(true, false, config(List.of(), List.of(), rollout(25)));
        Set<String> trueAt10 = new HashSet<>();
        Set<String> trueAt25 = new HashSet<>();
        for (int i = 0; i < 500; i++) {
            String key = "user-" + i;
            if ("true".equals(FlagEvaluator.evaluate(flag, at10, user(key), Map.of()).value())) {
                trueAt10.add(key);
            }
            if ("true".equals(FlagEvaluator.evaluate(flag, at25, user(key), Map.of()).value())) {
                trueAt25.add(key);
            }
        }
        assertTrue(trueAt25.containsAll(trueAt10), "ramping 10% -> 25% must keep early users");
        assertTrue(trueAt25.size() > trueAt10.size(), "ramp should admit new users");
        assertTrue(!trueAt10.isEmpty(), "10% of 500 users should not be empty");
    }

    @Test
    void rolloutServesBothVariationsAcrossUsers() {
        Flag flag = booleanFlag();
        FlagEnvConfig envConfig = env(true, false, config(List.of(), List.of(), rollout(50)));
        Set<String> values = new HashSet<>();
        for (int i = 0; i < 100; i++) {
            values.add(FlagEvaluator.evaluate(flag, envConfig, user("user-" + i), Map.of()).value());
        }
        assertEquals(Set.of("true", "false"), values);
    }

    // ------------------------------------------------ clauses

    @Test
    void missingAttributeFailsClause() {
        TargetingConfig config = config(
            List.of(), List.of(matchAllRule(FALSE_ID)), RolloutOrVariation.ofVariation(TRUE_ID));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-1"), Map.of());
        assertEquals(EvalReason.DEFAULT, outcome.reason());
    }

    @Test
    void keyAttributeReadsContextKey() {
        Rule rule = new Rule(RULE_ID, null,
            List.of(new Clause("key", ClauseOp.STARTS_WITH, List.of("beta-"))),
            RolloutOrVariation.ofVariation(FALSE_ID));
        TargetingConfig config = config(List.of(), List.of(rule), RolloutOrVariation.ofVariation(TRUE_ID));
        assertEquals(EvalReason.RULE_MATCH, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("beta-7"), Map.of()).reason());
        assertEquals(EvalReason.DEFAULT, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-7"), Map.of()).reason());
    }

    @Test
    void containsMatchesAnyValue() {
        Rule rule = new Rule(RULE_ID, null,
            List.of(new Clause("email", ClauseOp.CONTAINS, List.of("@ex.com", "@example.com"))),
            RolloutOrVariation.ofVariation(FALSE_ID));
        TargetingConfig config = config(List.of(), List.of(rule), RolloutOrVariation.ofVariation(TRUE_ID));
        assertEquals(EvalReason.RULE_MATCH, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("u", Map.of("email", "bob@example.com")), Map.of()).reason());
    }

    @Test
    void allClausesMustMatch() {
        Rule rule = new Rule(RULE_ID, null,
            List.of(new Clause("plan", ClauseOp.EQUALS, List.of("pro")),
                new Clause("region", ClauseOp.IN, List.of("us", "eu"))),
            RolloutOrVariation.ofVariation(FALSE_ID));
        TargetingConfig config = config(List.of(), List.of(rule), RolloutOrVariation.ofVariation(TRUE_ID));
        assertEquals(EvalReason.DEFAULT, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("u", Map.of("plan", "pro", "region", "apac")), Map.of()).reason());
        assertEquals(EvalReason.RULE_MATCH, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("u", Map.of("plan", "pro", "region", "eu")), Map.of()).reason());
    }

    // ------------------------------------------------ segments

    private static Segment segment(List<String> included, List<String> excluded, List<SegmentRule> rules) {
        return new Segment(UUID.randomUUID(), UUID.randomUUID(), "beta-testers", "Beta testers",
            included, excluded, rules, null);
    }

    private static TargetingConfig segmentMatchConfig(ClauseOp op) {
        Rule rule = new Rule(RULE_ID, null,
            List.of(new Clause("key", op, List.of("beta-testers"))),
            RolloutOrVariation.ofVariation(FALSE_ID));
        return new TargetingConfig(List.of(), List.of(rule),
            RolloutOrVariation.ofVariation(TRUE_ID), FALSE_ID, TRUE_ID);
    }

    @Test
    void segmentIncludedKeyMatches() {
        Map<String, Segment> segments = Map.of(
            "beta-testers", segment(List.of("user-1"), List.of(), List.of()));
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, segmentMatchConfig(ClauseOp.SEGMENT_MATCH)),
            user("user-1"), segments);
        assertEquals(EvalReason.RULE_MATCH, outcome.reason());
    }

    @Test
    void segmentExcludedKeyBeatsRules() {
        SegmentRule everyone = new SegmentRule(
            List.of(new Clause("key", ClauseOp.STARTS_WITH, List.of("user-"))));
        Map<String, Segment> segments = Map.of(
            "beta-testers", segment(List.of(), List.of("user-2"), List.of(everyone)));
        TargetingConfig config = segmentMatchConfig(ClauseOp.SEGMENT_MATCH);
        assertEquals(EvalReason.RULE_MATCH, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-1"), segments).reason());
        assertEquals(EvalReason.DEFAULT, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-2"), segments).reason());
    }

    @Test
    void segmentRuleMatchesByAttributes() {
        SegmentRule proPlan = new SegmentRule(
            List.of(new Clause("plan", ClauseOp.EQUALS, List.of("pro"))));
        Map<String, Segment> segments = Map.of(
            "beta-testers", segment(List.of(), List.of(), List.of(proPlan)));
        TargetingConfig config = segmentMatchConfig(ClauseOp.SEGMENT_MATCH);
        assertEquals(EvalReason.RULE_MATCH, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("user-9", Map.of("plan", "pro")), segments).reason());
        assertEquals(EvalReason.DEFAULT, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config),
            new EvalContext("user-9", Map.of("plan", "free")), segments).reason());
    }

    @Test
    void unknownSegmentFailsClauseWithoutError() {
        EvalOutcome outcome = FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, segmentMatchConfig(ClauseOp.SEGMENT_MATCH)),
            user("user-1"), Map.of());
        assertEquals(EvalReason.DEFAULT, outcome.reason());
    }

    @Test
    void notSegmentMatchInverts() {
        Map<String, Segment> segments = Map.of(
            "beta-testers", segment(List.of("user-1"), List.of(), List.of()));
        TargetingConfig config = segmentMatchConfig(ClauseOp.NOT_SEGMENT_MATCH);
        assertEquals(EvalReason.DEFAULT, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-1"), segments).reason());
        assertEquals(EvalReason.RULE_MATCH, FlagEvaluator.evaluate(
            booleanFlag(), env(true, false, config), user("user-9"), segments).reason());
    }
}
