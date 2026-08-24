package com.switchboard.domain.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.flag.FlagKind;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The diff is persisted as JSONB and read back on every proposal fetch, so a
 * silent round-trip break would only show up as a 500 in production.
 */
class FlagChangeDiffJsonTest {

    private final ObjectMapper json = new ObjectMapper()
        .findAndRegisterModules()
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    @Test
    void roundTripsAFullDiff() throws Exception {
        FlagChangeDiff diff = new FlagChangeDiff(
            ProposalKind.FLAG_CREATE, "checkout-v2", "Checkout v2", "New checkout",
            FlagKind.STRING,
            List.of(new VariationDraft("control", "Control"), new VariationDraft("variant", "Variant")),
            List.of("growth"),
            List.of(new EnvChange("production", true, false, new TargetingDraft(
                List.of(new ValueTarget("user-1", "variant")),
                List.of(new ValueRule("beta testers",
                    List.of(new ValueClause("plan", "IN", List.of("pro"))),
                    ValueServe.ofValue("variant"))),
                ValueServe.ofRollout(List.of(
                    new ValueWeight("control", 75), new ValueWeight("variant", 25))),
                "control", "control"))),
            null, List.of());

        String raw = json.writeValueAsString(diff);
        assertThat(json.readValue(raw, FlagChangeDiff.class)).isEqualTo(diff);
    }

    @Test
    void roundTripsAPartialDiffWithNullTargetingFields() throws Exception {
        // The monitor's proposals set only fallthrough; the nulls mean "leave alone"
        // and must survive persistence, not collapse into empty lists.
        FlagChangeDiff diff = new FlagChangeDiff(
            ProposalKind.FLAG_UPDATE, "heal-me", null, null, null, List.of(), List.of(),
            List.of(new EnvChange("production", null, null,
                new TargetingDraft(null, null, ValueServe.ofValue("true"), null, null))),
            null, List.of());

        FlagChangeDiff back = json.readValue(json.writeValueAsString(diff), FlagChangeDiff.class);

        assertThat(back).isEqualTo(diff);
        TargetingDraft targeting = back.envChanges().get(0).targeting();
        assertThat(targeting.rules()).isNull();
        assertThat(targeting.individualTargets()).isNull();
        assertThat(targeting.offVariationValue()).isNull();
    }
}
