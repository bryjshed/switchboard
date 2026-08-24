package com.switchboard.domain.evaluation;

import com.switchboard.domain.flag.Clause;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.IndividualTarget;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.Rule;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.flag.WeightedVariation;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRule;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Pure, deterministic flag evaluation. No I/O, no clock, no randomness: the same
 * inputs always produce the same outcome (rollout bucketing hashes flagKey:contextKey).
 *
 * <p>Precedence: kill switch, then enabled=false (both serve the off variation),
 * then individual targets on the context key, then rules in order (first rule whose
 * clauses ALL match wins), then fallthrough (rollout buckets with reason ROLLOUT,
 * fixed variation serves with reason DEFAULT).
 *
 * <p>This class is the REFERENCE IMPLEMENTATION of the cross-language evaluation contract
 * written down in {@code spec/evaluation.md} and proven by {@code spec/conformance/*.json}.
 * Any behaviour change here must land together with a spec change and regenerated vectors.
 */
public final class FlagEvaluator {

    /**
     * Size of the bucket space: {@link #bucket} returns an integer in {@code [0, BUCKET_SPACE)}.
     *
     * <p>10000 rather than 100 so one whole-percent of weight covers 100 buckets. Rollout weights
     * on the wire are still whole percents summing to 100, so behaviour today is identical to a
     * 100-bucket space; the two extra digits are headroom for finer-grained rollouts (0.01% steps)
     * later without another hash change and another reshuffle of every in-flight rollout.
     */
    public static final int BUCKET_SPACE = 10_000;

    /** Scales a whole-percent rollout weight into {@link #BUCKET_SPACE}. */
    private static final int WEIGHT_SCALE = BUCKET_SPACE / 100;

    private FlagEvaluator() {
    }

    public static EvalOutcome evaluate(
        Flag flag, FlagEnvConfig config, EvalContext context, Map<String, Segment> segmentsByKey) {

        TargetingConfig targeting = config.config();
        if (config.killSwitchActive()) {
            return outcome(flag, targeting.offVariationId(), EvalReason.KILL_SWITCH, null);
        }
        if (!config.enabled()) {
            return outcome(flag, targeting.offVariationId(), EvalReason.FLAG_OFF, null);
        }
        for (IndividualTarget target : targeting.individualTargets()) {
            if (target.contextKey().equals(context.key())) {
                return outcome(flag, target.variationId(), EvalReason.TARGET_MATCH, null);
            }
        }
        for (Rule rule : targeting.rules()) {
            if (allClausesMatch(rule.clauses(), context, segmentsByKey)) {
                UUID variationId = resolveServe(flag.key(), rule.serve(), context);
                return outcome(flag, variationId, EvalReason.RULE_MATCH, rule.id());
            }
        }
        RolloutOrVariation fallthrough = targeting.fallthrough();
        if (fallthrough.hasRollout()) {
            return outcome(flag, resolveServe(flag.key(), fallthrough, context), EvalReason.ROLLOUT, null);
        }
        return outcome(flag, fallthrough.variationId(), EvalReason.DEFAULT, null);
    }

    /**
     * Deterministic bucket in {@code [0, BUCKET_SPACE)} for this flag + context pair.
     *
     * <pre>bucket = int(hex(md5(flagKey + ":" + contextKey))[0:8], 16) % BUCKET_SPACE</pre>
     *
     * <p>The first 8 hex characters of the digest are its first 4 bytes read big-endian as an
     * unsigned 32-bit integer. The flagKey salt decorrelates rollouts across flags; taking the
     * bucket from a hash keeps ramps sticky (raising a weight only ever admits contexts).
     *
     * <p>MD5 is chosen for UBIQUITY, not security. It ships in the standard library of every
     * language a Switchboard SDK could target (JavaScript, Python, Go, Java, Ruby, PHP, Rust),
     * so every SDK reproduces this byte for byte. Nothing here is a security boundary: it hashes
     * a public flag key together with a caller-supplied context key to pick a variation, and a
     * collision or preimage buys an attacker nothing they could not get by choosing their own
     * context key. Do NOT "fix" this to SHA-256 or to a faster non-cryptographic hash. The digest
     * is part of the cross-language wire contract in {@code spec/evaluation.md}; changing it
     * reassigns every context in every in-flight rollout and desynchronises every deployed SDK
     * until it is upgraded. That needs a spec revision, regenerated conformance vectors, and a
     * deliberate migration - not a drive-by edit.
     */
    public static int bucket(String flagKey, String contextKey) {
        byte[] digest = md5(flagKey + ":" + contextKey);
        long prefix = ((long) (digest[0] & 0xFF) << 24)
            | ((long) (digest[1] & 0xFF) << 16)
            | ((long) (digest[2] & 0xFF) << 8)
            | (long) (digest[3] & 0xFF);
        return (int) (prefix % BUCKET_SPACE);
    }

    private static byte[] md5(String input) {
        try {
            return MessageDigest.getInstance("MD5").digest(input.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("every Java platform is required to provide MD5", e);
        }
    }

    private static UUID resolveServe(String flagKey, RolloutOrVariation serve, EvalContext context) {
        if (!serve.hasRollout()) {
            return serve.variationId();
        }
        int bucket = bucket(flagKey, context.key());
        int cumulative = 0;
        for (WeightedVariation weighted : serve.rollout()) {
            cumulative += weighted.weight() * WEIGHT_SCALE;
            if (bucket < cumulative) {
                return weighted.variationId();
            }
        }
        // Unreachable: weights sum to exactly 100, so cumulative ends at BUCKET_SPACE and bucket < BUCKET_SPACE.
        return serve.rollout().get(serve.rollout().size() - 1).variationId();
    }

    private static boolean allClausesMatch(
        List<Clause> clauses, EvalContext context, Map<String, Segment> segmentsByKey) {
        for (Clause clause : clauses) {
            if (!clauseMatches(clause, context, segmentsByKey)) {
                return false;
            }
        }
        return true;
    }

    private static boolean clauseMatches(Clause clause, EvalContext context, Map<String, Segment> segmentsByKey) {
        switch (clause.op()) {
            case SEGMENT_MATCH:
                return anySegmentMatches(clause.values(), context, segmentsByKey);
            case NOT_SEGMENT_MATCH:
                return !anySegmentMatches(clause.values(), context, segmentsByKey);
            default:
                return attributeClauseMatches(clause, context);
        }
    }

    /** The reserved attribute "key" reads the context key; anything else reads the attributes map. */
    private static boolean attributeClauseMatches(Clause clause, EvalContext context) {
        String attribute = "key".equals(clause.attribute())
            ? context.key()
            : context.attributes().get(clause.attribute());
        if (attribute == null) {
            return false;
        }
        return switch (clause.op()) {
            case EQUALS, IN -> clause.values().stream().anyMatch(attribute::equals);
            case CONTAINS -> clause.values().stream().anyMatch(attribute::contains);
            case STARTS_WITH -> clause.values().stream().anyMatch(attribute::startsWith);
            default -> false;
        };
    }

    /** True when ANY of the named segments matches. Unknown segment keys never match (no error). */
    private static boolean anySegmentMatches(
        List<String> segmentKeys, EvalContext context, Map<String, Segment> segmentsByKey) {
        for (String key : segmentKeys) {
            Segment segment = segmentsByKey.get(key);
            if (segment != null && segmentMatches(segment, context)) {
                return true;
            }
        }
        return false;
    }

    /** Excluded keys always lose, included keys always win, else ANY rule with all clauses matching. */
    private static boolean segmentMatches(Segment segment, EvalContext context) {
        if (segment.excludedKeys().contains(context.key())) {
            return false;
        }
        if (segment.includedKeys().contains(context.key())) {
            return true;
        }
        for (SegmentRule rule : segment.rules()) {
            if (allSegmentRuleClausesMatch(rule.clauses(), context)) {
                return true;
            }
        }
        return false;
    }

    /** Segment rules support attribute clauses only; nested segment ops fail the clause. */
    private static boolean allSegmentRuleClausesMatch(List<Clause> clauses, EvalContext context) {
        for (Clause clause : clauses) {
            boolean isSegmentOp = switch (clause.op()) {
                case SEGMENT_MATCH, NOT_SEGMENT_MATCH -> true;
                default -> false;
            };
            if (isSegmentOp || !attributeClauseMatches(clause, context)) {
                return false;
            }
        }
        return true;
    }

    private static EvalOutcome outcome(Flag flag, UUID variationId, EvalReason reason, UUID ruleId) {
        Variation variation = flag.variationById(variationId);
        return new EvalOutcome(variationId, variation == null ? null : variation.value(), reason, ruleId);
    }
}
