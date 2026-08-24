package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.EvalContext;
import com.switchboard.interfaces.rest.model.EvalReason;
import com.switchboard.interfaces.rest.model.EvalResult;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.KillSwitchRequest;
import com.switchboard.interfaces.rest.model.RolloutOrVariation;
import com.switchboard.interfaces.rest.model.SingleEvalRequest;
import com.switchboard.interfaces.rest.model.WeightedVariation;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * The SDK-facing surface, over HTTP with a real minted SDK key.
 *
 * <p>These are the contracts an SDK is written against: an unknown flag is the
 * SDK's own problem and never a 5xx, a context key always lands in the same
 * bucket, the kill switch takes effect on the next call, and the bootstrap
 * payload is conditional so a polling client costs almost nothing.
 */
class EvalApiIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    private Workspace workspace;
    private String sdkKey;

    @BeforeEach
    void seedEnvironment() {
        workspace = createWorkspace("eval");
        sdkKey = mintSdkKey(workspace, ENV_KEY);
    }

    @Test
    void anUnknownFlagServesTheSdkSuppliedDefault() {
        EvalResult result = evaluate("no-such-flag", "user-1", "sdk-fallback");

        assertThat(result.getReason()).isEqualTo(EvalReason.SDK_DEFAULT);
        assertThat(result.getValue()).isEqualTo("sdk-fallback");
        assertThat(result.getFlagKey()).isEqualTo("no-such-flag");
    }

    @Test
    void bucketingIsStickyAcrossRepeatedCalls() {
        FlagDetailResponse flag = createStringFlag(workspace, "copy-test", List.of("a", "b"));
        UUID variationA = variationId(flag, "a");
        UUID variationB = variationId(flag, "b");
        enable(flag.getKey(), new FlagTargetingConfig(
            new RolloutOrVariation()
                .addRolloutItem(new WeightedVariation(variationA, 50))
                .addRolloutItem(new WeightedVariation(variationB, 50)),
            variationB, variationA), 1);

        EvalResult first = evaluate(flag.getKey(), "user-42", "unused");
        assertThat(first.getReason()).isEqualTo(EvalReason.ROLLOUT);
        for (int i = 0; i < 5; i++) {
            EvalResult repeat = evaluate(flag.getKey(), "user-42", "unused");
            assertThat(repeat.getVariationId()).isEqualTo(first.getVariationId());
            assertThat(repeat.getValue()).isEqualTo(first.getValue());
        }

        // A 50/50 split really splits: the stickiness above is not a constant answer.
        Set<String> served = IntStream.range(0, 100)
            .mapToObj(i -> evaluate(flag.getKey(), "user-" + i, "unused").getValue())
            .collect(Collectors.toSet());
        assertThat(served).containsExactlyInAnyOrder("a", "b");
    }

    @Test
    void theKillSwitchFlipsTheServedVariation() {
        FlagDetailResponse flag = createBooleanFlag(workspace, "payments-v2");
        UUID onId = variationId(flag, "true");
        UUID offId = variationId(flag, "false");
        enable(flag.getKey(), new FlagTargetingConfig(
            new RolloutOrVariation().variationId(onId), offId, onId), 1);

        EvalResult live = evaluate(flag.getKey(), "user-1", "unused");
        assertThat(live.getReason()).isEqualTo(EvalReason.DEFAULT);
        assertThat(live.getValue()).isEqualTo("true");

        http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/kill-switch",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new KillSwitchRequest(true).reason("checkout is erroring"))
            .exchange()
            .expectStatus().isOk();

        EvalResult killed = evaluate(flag.getKey(), "user-1", "unused");
        assertThat(killed.getReason()).isEqualTo(EvalReason.KILL_SWITCH);
        assertThat(killed.getValue()).isEqualTo("false");
    }

    @Test
    void bootstrapIsConditionalOnItsEtag() {
        createBooleanFlag(workspace, "bootstrap-flag");

        String etag = http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .exchange()
            .expectStatus().isOk()
            .expectHeader().exists(HttpHeaders.ETAG)
            .expectBody()
            .jsonPath("$.envKey").isEqualTo(ENV_KEY)
            .jsonPath("$.flags.length()").isEqualTo(1)
            .returnResult().getResponseHeaders().getETag();

        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .header(HttpHeaders.IF_NONE_MATCH, etag)
            .exchange()
            .expectStatus().isNotModified();
    }

    // ---------------------------------------------------------------- helpers

    private EvalResult evaluate(String flagKey, String contextKey, String sdkDefault) {
        return http.post().uri("/api/eval/{flagKey}", flagKey)
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .bodyValue(new SingleEvalRequest(new EvalContext(contextKey))._default(sdkDefault))
            .exchange()
            .expectStatus().isOk()
            .expectBody(EvalResult.class)
            .returnResult().getResponseBody();
    }

    private void enable(String flagKey, FlagTargetingConfig config, int expectedVersion) {
        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flagKey, ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new FlagEnvConfigUpdateRequest(true, config).expectedVersion(expectedVersion))
            .exchange()
            .expectStatus().isOk();
    }
}
