package com.switchboard.infrastructure.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.anthropic.models.messages.Tool;
import org.junit.jupiter.api.Test;

/**
 * The tool schema is only exercised end to end when an API key is configured, so
 * this asserts the SDK accepts it. A malformed schema would otherwise surface as
 * a 400 from the provider on the first real draft.
 */
class FlagChangeToolSchemaTest {

    @Test
    void buildsAToolTheSdkConsidersValid() {
        Tool tool = FlagChangeToolSchema.tool();

        assertThat(tool.isValid()).isTrue();
        assertThat(tool.name()).isEqualTo("propose_flag_change");
        assertThat(tool.inputSchema().properties()).isPresent();
        assertThat(tool.inputSchema().required()).contains(java.util.List.of("kind", "flagKey", "rationale"));
    }

    @Test
    void spellsOutTheValueNotUuidConventionInTheDescription() {
        // Apply time resolves value -> UUID, so the model must never emit ids.
        assertThat(FlagChangeToolSchema.tool().description().orElseThrow())
            .contains("VALUE string")
            .contains("NEVER by UUID");
    }
}
