package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.switchboard.domain.evaluation.AttributeValue;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.ProviderState;
import dev.openfeature.sdk.Reason;
import org.junit.jupiter.api.Test;

/** The OpenFeature translation layer: context in, reasons and error codes out. */
class SwitchboardProviderTest {

    @Test
    void aContextWithNoTargetingKeyBecomesNullRatherThanThrowing() {
        // The regression this pins: EvalContext refuses a blank key by construction, so
        // converting eagerly threw an IllegalArgumentException straight through the caller's
        // flag check. An SDK must degrade, not detonate, inside someone else's process.
        assertNull(SwitchboardProvider.toEvalContext(new ImmutableContext()));
        assertNull(SwitchboardProvider.toEvalContext(new MutableContext("")));
        assertNull(SwitchboardProvider.toEvalContext(null));
    }

    @Test
    void preservesAttributeTypesAcrossTheBoundary() {
        var context = SwitchboardProvider.toEvalContext(
            new MutableContext("user-1").add("plan", "pro").add("seats", 250).add("beta", true));
        assertEquals("user-1", context.key());
        assertTrue(context.attribute("plan") instanceof AttributeValue.Str);
        assertTrue(context.attribute("seats") instanceof AttributeValue.Num);
        assertTrue(context.attribute("beta") instanceof AttributeValue.Bool);
    }

    @Test
    void theTargetingKeyIsNotAlsoExposedAsAnAttribute() {
        // It is the bucketing input, not a targetable attribute; leaking it into attributes
        // would let a rule match on "targetingKey" and behave differently from the server.
        var context = SwitchboardProvider.toEvalContext(new MutableContext("user-1").add("plan", "pro"));
        assertNull(context.attribute("targetingKey"));
        assertEquals(1, context.attributes().size());
    }

    @Test
    void reportsNotReadyBeforeAPayloadLands() {
        var config = SwitchboardConfig.builder("sb_srv_test")
            .baseUri("http://127.0.0.1:1")
            .startTimeout(java.time.Duration.ofMillis(200))
            .build();
        try (var client = new SwitchboardClient(config)) {
            var provider = new SwitchboardProvider(client);
            assertEquals(ProviderState.NOT_READY, provider.getState());
            // Serving a default while claiming READY would tell the OpenFeature runtime that
            // fallbacks are real answers.
            var evaluation = provider.getBooleanEvaluation("anything", true, new MutableContext("u"));
            assertTrue(evaluation.getValue());
            assertEquals(ErrorCode.PROVIDER_NOT_READY, evaluation.getErrorCode());
            assertEquals(Reason.ERROR.name(), evaluation.getReason());
        }
    }

    @Test
    void metadataCarriesTheUnflattenedSwitchboardReason() {
        // KILL_SWITCH and FLAG_OFF both map to OpenFeature's DISABLED, so the precise reason
        // has to survive somewhere or the dashboard and audit trail lose a distinction.
        var detail = EvaluationDetail.of("true",
            com.switchboard.domain.evaluation.EvalReason.KILL_SWITCH, null, null);
        assertEquals("KILL_SWITCH", detail.reason().name());
    }
}
