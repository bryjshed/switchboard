package com.switchboard.domain.flag;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * JSONB round-trip guard: TargetingConfig must survive ObjectMapper
 * serialize/deserialize unchanged (derived isX() accessors on records have
 * silently broken round-trips before - see RolloutOrVariation.hasRollout).
 */
class TargetingConfigJsonTest {

    @Test
    void roundTripsThroughJson() throws Exception {
        ObjectMapper json = new ObjectMapper();
        UUID trueId = UUID.randomUUID();
        UUID falseId = UUID.randomUUID();
        TargetingConfig config = new TargetingConfig(
            List.of(new IndividualTarget("user-1", trueId)),
            List.of(new Rule(UUID.randomUUID(), "beta rule",
                List.of(new Clause("key", ClauseOp.SEGMENT_MATCH, List.of("beta-testers"))),
                RolloutOrVariation.ofRollout(List.of(
                    new WeightedVariation(trueId, 25), new WeightedVariation(falseId, 75))))),
            RolloutOrVariation.ofVariation(trueId),
            falseId, trueId);

        String raw = json.writeValueAsString(config);
        TargetingConfig back = json.readValue(raw, TargetingConfig.class);
        assertEquals(config, back);

        String rawAgain = json.writeValueAsString(back);
        assertEquals(json.readTree(raw), json.readTree(rawAgain));
    }
}
