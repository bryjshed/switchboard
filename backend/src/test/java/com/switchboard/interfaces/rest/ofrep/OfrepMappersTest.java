package com.switchboard.interfaces.rest.ofrep;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.switchboard.domain.evaluation.AttributeValue;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.EvalOutcome;
import com.switchboard.domain.evaluation.EvalReason;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagAndConfig;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * The OFREP adapter in isolation. The reason table below is a wire contract with six
 * OpenFeature-maintained providers, so it is asserted exhaustively rather than by sampling: a
 * Switchboard reason that quietly stopped mapping would surface as a provider reporting the wrong
 * resolution reason, which nothing else in the suite would catch.
 */
class OfrepMappersTest {

    private static final UUID ON = UUID.randomUUID();
    private static final UUID OFF = UUID.randomUUID();

    @ParameterizedTest
    @CsvSource({
        "KILL_SWITCH,  DISABLED",
        "FLAG_OFF,     DISABLED",
        "TARGET_MATCH, TARGETING_MATCH",
        "RULE_MATCH,   TARGETING_MATCH",
        "ROLLOUT,      SPLIT",
        "DEFAULT,      STATIC",
        "SDK_DEFAULT,  UNKNOWN"
    })
    void everySwitchboardReasonMapsOntoAnOfrepReason(EvalReason switchboard, OfrepReason ofrep) {
        assertThat(OfrepMappers.toReason(new EvalOutcome(ON, "true", switchboard, null))).isEqualTo(ofrep);
    }

    @Test
    void aResolvedVariationWithNoValueIsUnknownWhateverTheReason() {
        for (EvalReason reason : EvalReason.values()) {
            assertThat(OfrepMappers.toReason(new EvalOutcome(ON, null, reason, null)))
                .isEqualTo(OfrepReason.UNKNOWN);
        }
    }

    @Test
    void booleanFlagsEmitJsonBooleansAndStringFlagsEmitStrings() {
        assertThat(OfrepMappers.toValue(FlagKind.BOOLEAN, "true")).isEqualTo(Boolean.TRUE);
        assertThat(OfrepMappers.toValue(FlagKind.BOOLEAN, "false")).isEqualTo(Boolean.FALSE);
        assertThat(OfrepMappers.toValue(FlagKind.BOOLEAN, null)).isEqualTo(Boolean.FALSE);
        assertThat(OfrepMappers.toValue(FlagKind.STRING, "compact")).isEqualTo("compact");
        // Never coerced: OpenFeature type-checks client side, so a guessed number breaks the call.
        assertThat(OfrepMappers.toValue(FlagKind.STRING, "42")).isEqualTo("42");
        assertThat(OfrepMappers.toValue(FlagKind.STRING, "{\"a\":1}")).isEqualTo("{\"a\":1}");
        assertThat(OfrepMappers.toValue(FlagKind.STRING, null)).isEqualTo("");
    }

    @Test
    void theVariantIsTheVariationNameFallingBackToItsValue() {
        Flag named = flag(FlagKind.STRING, new Variation(ON, "compact", "Compact"), new Variation(OFF, "roomy", null));

        assertThat(success(named, new EvalOutcome(ON, "compact", EvalReason.DEFAULT, null)).variant())
            .isEqualTo("Compact");
        assertThat(success(named, new EvalOutcome(OFF, "roomy", EvalReason.DEFAULT, null)).variant())
            .isEqualTo("roomy");
        assertThat(success(named, new EvalOutcome(UUID.randomUUID(), null, EvalReason.DEFAULT, null)).variant())
            .isNull();
    }

    @Test
    void nothingSwitchboardKnowsIsLostFromMetadata() {
        UUID ruleId = UUID.randomUUID();
        Flag flag = flag(FlagKind.BOOLEAN, new Variation(ON, "true", "True"), new Variation(OFF, "false", "False"));

        Map<String, Object> metadata =
            success(flag, new EvalOutcome(ON, "true", EvalReason.RULE_MATCH, ruleId)).metadata();

        assertThat(metadata)
            .containsEntry("switchboard.reason", "RULE_MATCH")
            .containsEntry("switchboard.flagVersion", 7)
            .containsEntry("switchboard.flagKind", "BOOLEAN")
            .containsEntry("switchboard.variationId", ON.toString())
            .containsEntry("switchboard.ruleId", ruleId.toString());
    }

    /** ruleId only ever describes a RULE_MATCH; carrying it elsewhere would be a lie. */
    @Test
    void theRuleIdIsOmittedWhenNoRuleDecided() {
        Flag flag = flag(FlagKind.BOOLEAN, new Variation(ON, "true", "True"), new Variation(OFF, "false", "False"));

        assertThat(success(flag, new EvalOutcome(ON, "true", EvalReason.ROLLOUT, UUID.randomUUID())).metadata())
            .doesNotContainKey("switchboard.ruleId");
    }

    // ---------------------------------------------------------------- context

    @Test
    void theTargetingKeyBecomesTheSwitchboardContextKey() {
        EvalContext context = OfrepMappers.toEvalContext(
            new OfrepEvaluationRequest(Map.of("targetingKey", "user-1")), "flag");

        assertThat(context.key()).isEqualTo("user-1");
        assertThat(context.attributes()).isEmpty();
    }

    @Test
    void attributesKeepTheirTypesAndArraysSurvive() {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("targetingKey", "user-1");
        raw.put("plan", "pro");
        raw.put("beta", true);
        raw.put("seats", 42);
        raw.put("ratio", 4.5);
        raw.put("account", Map.of("tier", "gold"));
        raw.put("roles", List.of("admin", "billing"));
        raw.put("absent", null);

        EvalContext context = OfrepMappers.toEvalContext(new OfrepEvaluationRequest(raw), "flag");

        // This used to stringify every scalar and DROP arrays outright, which meant an OFREP caller
        // could not use the numeric or version operators at all and could not target on a list.
        // Types are preserved now, so an OFREP provider gets the same expressiveness a native
        // caller does.
        assertThat(context.attribute("plan")).isEqualTo(AttributeValue.of("pro"));
        assertThat(context.attribute("beta")).isEqualTo(AttributeValue.of(true));
        assertThat(context.attribute("seats")).isEqualTo(AttributeValue.of(42d));
        assertThat(context.attribute("ratio")).isEqualTo(AttributeValue.of(4.5d));
        assertThat(context.attribute("roles"))
            .isEqualTo(new AttributeValue.Arr(List.of(
                AttributeValue.of("admin"), AttributeValue.of("billing"))));

        // Still dropped, and for the reason spec 3.1 gives: no operator can act on an object, and
        // null means absent rather than a value that could match something.
        assertThat(context.attributes()).doesNotContainKeys("account", "absent");
    }

    @Test
    void aMissingOrUnusableTargetingKeyIsTargetingKeyMissing() {
        assertBadRequest(new OfrepEvaluationRequest(Map.of("plan", "pro")), OfrepErrorCode.TARGETING_KEY_MISSING);
        assertBadRequest(new OfrepEvaluationRequest(Map.of("targetingKey", "   ")),
            OfrepErrorCode.TARGETING_KEY_MISSING);
        assertBadRequest(new OfrepEvaluationRequest(Map.of("targetingKey", 42)),
            OfrepErrorCode.TARGETING_KEY_MISSING);
        assertBadRequest(new OfrepEvaluationRequest(null), OfrepErrorCode.TARGETING_KEY_MISSING);
        assertBadRequest(null, OfrepErrorCode.TARGETING_KEY_MISSING);
    }

    @Test
    void aContextThatIsNotAnObjectIsInvalidContext() {
        assertBadRequest(new OfrepEvaluationRequest("user-1"), OfrepErrorCode.INVALID_CONTEXT);
        assertBadRequest(new OfrepEvaluationRequest(List.of("user-1")), OfrepErrorCode.INVALID_CONTEXT);
    }

    // ---------------------------------------------------------------- helpers

    private static void assertBadRequest(OfrepEvaluationRequest request, OfrepErrorCode expected) {
        assertThatThrownBy(() -> OfrepMappers.toEvalContext(request, "flag"))
            .isInstanceOf(OfrepBadRequestException.class)
            .satisfies(e -> {
                OfrepBadRequestException failure = (OfrepBadRequestException) e;
                assertThat(failure.errorCode()).isEqualTo(expected);
                assertThat(failure.flagKey()).isEqualTo("flag");
                assertThat(failure.getMessage()).isNotBlank();
            });
    }

    private static OfrepEvaluationSuccess success(Flag flag, EvalOutcome outcome) {
        return OfrepMappers.toSuccess(new FlagAndConfig(flag, config(flag)), outcome);
    }

    private static Flag flag(FlagKind kind, Variation... variations) {
        return new Flag(UUID.randomUUID(), UUID.randomUUID(), "a-flag", "A flag", null,
            kind, List.of(variations), List.of(), false);
    }

    private static FlagEnvConfig config(Flag flag) {
        return new FlagEnvConfig(
            flag.id(),
            UUID.randomUUID(),
            true,
            false,
            new TargetingConfig(List.of(), List.of(), RolloutOrVariation.ofVariation(ON), OFF, ON),
            7,
            Instant.EPOCH,
            "test");
    }
}
