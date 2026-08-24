package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.Clause;
import com.switchboard.interfaces.rest.model.ClauseOp;
import com.switchboard.interfaces.rest.model.EvalContext;
import com.switchboard.interfaces.rest.model.EvalResult;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.IndividualTarget;
import com.switchboard.interfaces.rest.model.KillSwitchRequest;
import com.switchboard.interfaces.rest.model.RolloutOrVariation;
import com.switchboard.interfaces.rest.model.Rule;
import com.switchboard.interfaces.rest.model.SingleEvalRequest;
import com.switchboard.interfaces.rest.model.WeightedVariation;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * OFREP - the OpenFeature Remote Evaluation Protocol - over HTTP with a real minted SDK key.
 *
 * <p>These assertions are deliberately about BYTES, not about Java objects: OFREP exists so that
 * six providers nobody here maintains can talk to Switchboard, and those providers parse JSON. A
 * BOOLEAN flag that serves the string "true" instead of the literal true is a broken provider, not
 * a cosmetic difference, so the boolean-ness is asserted rather than the value alone.
 */
class OfrepApiIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";
    private static final String SINGLE = "/ofrep/v1/evaluate/flags/{key}";
    private static final String BULK = "/ofrep/v1/evaluate/flags";

    private Workspace workspace;
    private String sdkKey;

    @BeforeEach
    void seedEnvironment() {
        workspace = createWorkspace("ofrep");
        sdkKey = mintSdkKey(workspace, ENV_KEY);
    }

    // ---------------------------------------------------------------- value typing

    @Test
    void aBooleanFlagServesARealJsonBooleanNotTheStringTrue() {
        FlagDetailResponse flag = createBooleanFlag(workspace, "checkout-v2");
        serveFallthrough(flag, "true");

        evaluate("checkout-v2", context("user-1"))
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.key").isEqualTo("checkout-v2")
            .jsonPath("$.value").isBoolean()
            .jsonPath("$.value").isEqualTo(true)
            .jsonPath("$.reason").isEqualTo("STATIC")
            .jsonPath("$.variant").isEqualTo("True");

        assertThat(rawBody("checkout-v2", context("user-1")))
            .contains("\"value\":true")
            .doesNotContain("\"value\":\"true\"");
    }

    @Test
    void aStringFlagServesItsStringVerbatim() {
        FlagDetailResponse flag = createStringFlag(workspace, "planner-layout", List.of("compact", "roomy"));
        serveFallthrough(flag, "compact");

        evaluate("planner-layout", context("user-1"))
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.value").isEqualTo("compact")
            .jsonPath("$.variant").isEqualTo("compact")
            .jsonPath("$.reason").isEqualTo("STATIC");
    }

    /** A numeric-looking string flag stays a string: guessing a type would break provider checks. */
    @Test
    void aNumericLookingStringFlagIsStillAString() {
        FlagDetailResponse flag = createStringFlag(workspace, "retry-budget", List.of("3", "5"));
        serveFallthrough(flag, "3");

        evaluate("retry-budget", context("user-1"))
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.value").isEqualTo("3")
            .jsonPath("$.value").isNotEmpty();

        assertThat(rawBody("retry-budget", context("user-1"))).contains("\"value\":\"3\"");
    }

    // ---------------------------------------------------------------- reason mapping

    @Test
    void switchboardReasonsMapOntoTheFiveOfrepReasons() {
        // DEFAULT -> STATIC
        FlagDetailResponse fixed = createBooleanFlag(workspace, "reason-static");
        serveFallthrough(fixed, "true");
        assertReason("reason-static", context("user-1"), "STATIC", "DEFAULT");

        // FLAG_OFF -> DISABLED (a freshly created flag is disabled in every environment)
        createBooleanFlag(workspace, "reason-flag-off");
        assertReason("reason-flag-off", context("user-1"), "DISABLED", "FLAG_OFF");

        // KILL_SWITCH -> DISABLED
        FlagDetailResponse killed = createBooleanFlag(workspace, "reason-killed");
        serveFallthrough(killed, "true");
        killSwitch("reason-killed");
        assertReason("reason-killed", context("user-1"), "DISABLED", "KILL_SWITCH");

        // TARGET_MATCH -> TARGETING_MATCH
        FlagDetailResponse targeted = createBooleanFlag(workspace, "reason-target");
        UUID targetOn = variationId(targeted, "true");
        UUID targetOff = variationId(targeted, "false");
        putConfig("reason-target", new FlagTargetingConfig(
            new RolloutOrVariation().variationId(targetOff), targetOff, targetOff)
            .individualTargets(List.of(new IndividualTarget("alice", targetOn))), 1);
        assertReason("reason-target", context("alice"), "TARGETING_MATCH", "TARGET_MATCH");

        // RULE_MATCH -> TARGETING_MATCH, and the deciding rule id survives in metadata
        FlagDetailResponse ruled = createBooleanFlag(workspace, "reason-rule");
        UUID ruleOn = variationId(ruled, "true");
        UUID ruleOff = variationId(ruled, "false");
        UUID ruleId = UUID.randomUUID();
        putConfig("reason-rule", new FlagTargetingConfig(
            new RolloutOrVariation().variationId(ruleOff), ruleOff, ruleOff)
            .rules(List.of(new Rule(
                ruleId,
                List.of(new Clause("plan", ClauseOp.EQUALS, List.of("pro"))),
                new RolloutOrVariation().variationId(ruleOn)))), 1);
        evaluate("reason-rule", context("user-1", Map.of("plan", "pro")))
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.reason").isEqualTo("TARGETING_MATCH")
            .jsonPath("$.metadata['switchboard.reason']").isEqualTo("RULE_MATCH")
            .jsonPath("$.metadata['switchboard.ruleId']").isEqualTo(ruleId.toString());

        // ROLLOUT -> SPLIT
        FlagDetailResponse ramping = createBooleanFlag(workspace, "reason-rollout");
        UUID rampOn = variationId(ramping, "true");
        UUID rampOff = variationId(ramping, "false");
        putConfig("reason-rollout", new FlagTargetingConfig(
            new RolloutOrVariation()
                .addRolloutItem(new WeightedVariation(rampOn, 50))
                .addRolloutItem(new WeightedVariation(rampOff, 50)),
            rampOff, rampOn), 1);
        assertReason("reason-rollout", context("user-42"), "SPLIT", "ROLLOUT");
    }

    /**
     * UNKNOWN: the config resolves to a variation that no longer exists on the flag. Switchboard
     * reached a decision but cannot name a value for it, which is what UNKNOWN means. Written
     * straight to the row because the API's own invariants make it unreachable through the API -
     * and served from a DIFFERENT environment so no earlier test has warmed that snapshot.
     */
    @Test
    void aResolvedVariationThatNoLongerExistsIsUnknown() {
        String stagingKey = mintSdkKey(workspace, "staging");
        createBooleanFlag(workspace, "reason-unknown");
        execute("""
            UPDATE flag_env_configs c
            SET config = jsonb_set(c.config, '{offVariationId}', '"00000000-0000-0000-0000-000000000000"')
            FROM flags f
            WHERE f.id = c.flag_id AND f.key = 'reason-unknown' AND c.environment_id = :envId
            """, Map.of("envId", workspace.environmentId("staging")));

        http.post().uri(SINGLE, "reason-unknown")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + stagingKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", context("user-1")))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.reason").isEqualTo("UNKNOWN")
            .jsonPath("$.value").isEqualTo(false)
            .jsonPath("$.variant").doesNotExist()
            .jsonPath("$.metadata['switchboard.reason']").isEqualTo("FLAG_OFF");
    }

    @Test
    void theNativeReasonAndFlagVersionSurviveInMetadata() {
        FlagDetailResponse flag = createBooleanFlag(workspace, "meta-flag");
        serveFallthrough(flag, "true");

        evaluate("meta-flag", context("user-1"))
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.metadata['switchboard.reason']").isEqualTo("DEFAULT")
            .jsonPath("$.metadata['switchboard.flagKind']").isEqualTo("BOOLEAN")
            .jsonPath("$.metadata['switchboard.flagVersion']").isEqualTo(2)
            .jsonPath("$.metadata['switchboard.variationId']").isEqualTo(variationId(flag, "true").toString());
    }

    // ---------------------------------------------------------------- errors

    @Test
    void anUnknownFlagIs404FlagNotFound() {
        evaluate("no-such-flag", context("user-1"))
            .expectStatus().isNotFound()
            .expectBody()
            .jsonPath("$.key").isEqualTo("no-such-flag")
            .jsonPath("$.errorCode").isEqualTo("FLAG_NOT_FOUND")
            .jsonPath("$.errorDetails").isNotEmpty();
    }

    @Test
    void aMissingTargetingKeyIs400TargetingKeyMissing() {
        createBooleanFlag(workspace, "needs-key");

        evaluate("needs-key", Map.of("plan", "pro"))
            .expectStatus().isBadRequest()
            .expectBody()
            .jsonPath("$.key").isEqualTo("needs-key")
            .jsonPath("$.errorCode").isEqualTo("TARGETING_KEY_MISSING");

        evaluate("needs-key", Map.of("targetingKey", "  "))
            .expectStatus().isBadRequest()
            .expectBody()
            .jsonPath("$.errorCode").isEqualTo("TARGETING_KEY_MISSING");
    }

    @Test
    void aContextThatIsNotAnObjectIsInvalidContext() {
        http.post().uri(SINGLE, "anything")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", "user-1"))
            .exchange()
            .expectStatus().isBadRequest()
            .expectBody()
            .jsonPath("$.errorCode").isEqualTo("INVALID_CONTEXT");
    }

    @Test
    void aMalformedBodyIsParseError() {
        http.post().uri(SINGLE, "anything")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue("{\"context\":")
            .exchange()
            .expectStatus().isBadRequest()
            .expectBody()
            .jsonPath("$.key").isEqualTo("anything")
            .jsonPath("$.errorCode").isEqualTo("PARSE_ERROR");
    }

    /** The bulk 400 is OFREP's bulkEvaluationFailure, which has no key at all. */
    @Test
    void theBulkErrorCarriesNoFlagKey() {
        http.post().uri(BULK)
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", Map.of("plan", "pro")))
            .exchange()
            .expectStatus().isBadRequest()
            .expectBody()
            .jsonPath("$.errorCode").isEqualTo("TARGETING_KEY_MISSING")
            .jsonPath("$.key").doesNotExist();
    }

    // ---------------------------------------------------------------- bulk

    @Test
    void bulkEvaluatesEveryFlagAndAdvertisesTheStream() {
        FlagDetailResponse on = createBooleanFlag(workspace, "bulk-boolean");
        serveFallthrough(on, "true");
        FlagDetailResponse copy = createStringFlag(workspace, "bulk-string", List.of("a", "b"));
        serveFallthrough(copy, "b");

        bulk(context("user-1"), null)
            .expectStatus().isOk()
            .expectHeader().exists(HttpHeaders.ETAG)
            .expectBody()
            .jsonPath("$.flags.length()").isEqualTo(2)
            .jsonPath("$.flags[?(@.key == 'bulk-boolean')].value").isEqualTo(true)
            .jsonPath("$.flags[?(@.key == 'bulk-string')].value").isEqualTo("b")
            .jsonPath("$.metadata['switchboard.envKey']").isEqualTo(ENV_KEY)
            .jsonPath("$.eventStreams[0].type").isEqualTo("sse")
            .jsonPath("$.eventStreams[0].endpoint.requestUri").isEqualTo("/ofrep/v1/stream")
            .jsonPath("$.eventStreams[0].inactivityDelaySec").isEqualTo(120);
    }

    @Test
    void bulkIsConditionalOnItsEtagAndAgreesWithBootstrap() {
        createBooleanFlag(workspace, "bulk-conditional");

        String etag = bulk(context("user-1"), null)
            .expectStatus().isOk()
            .expectBody().returnResult().getResponseHeaders().getETag();

        bulk(context("user-1"), etag).expectStatus().isNotModified().expectBody().isEmpty();

        // The two conditional endpoints must quote the same environment cursor, or a client that
        // uses both would thrash between them.
        String bootstrapEtag = http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .exchange()
            .expectStatus().isOk()
            .expectBody().returnResult().getResponseHeaders().getETag();
        assertThat(etag).isEqualTo(bootstrapEtag);

        // A write moves it on.
        FlagDetailResponse flag = createBooleanFlag(workspace, "bulk-conditional-2");
        serveFallthrough(flag, "true");
        String next = bulk(context("user-1"), etag)
            .expectStatus().isOk()
            .expectBody().returnResult().getResponseHeaders().getETag();
        assertThat(next).isNotEqualTo(etag);
    }

    // ---------------------------------------------------------------- auth

    @Test
    void noCredentialsIs401AndAUserTokenIs403() {
        http.post().uri(SINGLE, "anything")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", context("user-1")))
            .exchange()
            .expectStatus().isUnauthorized()
            .expectBody().isEmpty();

        http.post().uri(SINGLE, "anything")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", context("user-1")))
            .exchange()
            .expectStatus().isForbidden()
            .expectBody().isEmpty();

        http.post().uri(BULK)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", context("user-1")))
            .exchange()
            .expectStatus().isUnauthorized();

        http.get().uri("/ofrep/v1/stream")
            .exchange()
            .expectStatus().isUnauthorized();
    }

    @Test
    void theXapiKeyHeaderAuthenticatesExactlyLikeBearer() {
        FlagDetailResponse flag = createBooleanFlag(workspace, "apikey-flag");
        serveFallthrough(flag, "true");

        http.post().uri(SINGLE, "apikey-flag")
            .header("X-API-Key", sdkKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", context("user-1")))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.value").isEqualTo(true)
            .jsonPath("$.reason").isEqualTo("STATIC");

        // A user credential in the SDK header is not a credential at all: 401, not a 403 that
        // would suggest the token was understood.
        http.post().uri(SINGLE, "apikey-flag")
            .header("X-API-Key", "dev:" + workspace.ownerEmail())
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", context("user-1")))
            .exchange()
            .expectStatus().isUnauthorized();
    }

    // ---------------------------------------------------------------- cross-check

    /**
     * OFREP is a wire adapter over the same evaluator, so for the same flag and context it must
     * agree with {@code POST /api/eval/{flagKey}} on the value and on the reason - once the reason
     * is put through the documented mapping. Any disagreement is an adapter bug.
     */
    @Test
    void ofrepAgreesWithTheNativeEvaluationApi() {
        FlagDetailResponse ramping = createBooleanFlag(workspace, "cross-rollout");
        UUID on = variationId(ramping, "true");
        UUID off = variationId(ramping, "false");
        putConfig("cross-rollout", new FlagTargetingConfig(
            new RolloutOrVariation()
                .addRolloutItem(new WeightedVariation(on, 50))
                .addRolloutItem(new WeightedVariation(off, 50)),
            off, on)
            .individualTargets(List.of(new IndividualTarget("alice", on))), 1);
        FlagDetailResponse copy = createStringFlag(workspace, "cross-string", List.of("a", "b"));
        serveFallthrough(copy, "b");
        FlagDetailResponse killed = createBooleanFlag(workspace, "cross-killed");
        serveFallthrough(killed, "true");
        killSwitch("cross-killed");

        Map<String, String> expectedOfrepReason = Map.of(
            "KILL_SWITCH", "DISABLED",
            "FLAG_OFF", "DISABLED",
            "TARGET_MATCH", "TARGETING_MATCH",
            "RULE_MATCH", "TARGETING_MATCH",
            "ROLLOUT", "SPLIT",
            "DEFAULT", "STATIC");

        for (String flagKey : List.of("cross-rollout", "cross-string", "cross-killed")) {
            for (String contextKey : List.of("alice", "user-1", "user-42", "user-99")) {
                EvalResult fromNativeApi = http.post().uri("/api/eval/{flagKey}", flagKey)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
                    .bodyValue(new SingleEvalRequest(new EvalContext(contextKey)))
                    .exchange()
                    .expectStatus().isOk()
                    .expectBody(EvalResult.class)
                    .returnResult().getResponseBody();

                boolean isBoolean = !"cross-string".equals(flagKey);
                Object expectedValue = isBoolean
                    ? Boolean.valueOf(fromNativeApi.getValue())
                    : fromNativeApi.getValue();

                evaluate(flagKey, context(contextKey))
                    .expectStatus().isOk()
                    .expectBody()
                    .jsonPath("$.value").isEqualTo(expectedValue)
                    .jsonPath("$.reason").isEqualTo(expectedOfrepReason.get(fromNativeApi.getReason().name()))
                    .jsonPath("$.metadata['switchboard.reason']").isEqualTo(fromNativeApi.getReason().name())
                    .jsonPath("$.metadata['switchboard.variationId']")
                    .isEqualTo(fromNativeApi.getVariationId().toString());
            }
        }
    }

    /** Context attributes are strings in Switchboard; OFREP scalars coerce, containers are dropped. */
    @Test
    void nonStringContextPropertiesCoerceAndContainersAreSkipped() {
        FlagDetailResponse flag = createBooleanFlag(workspace, "coercion");
        UUID on = variationId(flag, "true");
        UUID off = variationId(flag, "false");
        putConfig("coercion", new FlagTargetingConfig(
            new RolloutOrVariation().variationId(off), off, off)
            .rules(List.of(new Rule(
                UUID.randomUUID(),
                List.of(
                    new Clause("beta", ClauseOp.EQUALS, List.of("true")),
                    new Clause("seats", ClauseOp.EQUALS, List.of("42"))),
                new RolloutOrVariation().variationId(on)))), 1);

        Map<String, Object> context = new LinkedHashMap<>();
        context.put("targetingKey", "user-1");
        context.put("beta", true);
        context.put("seats", 42);
        // Skipped, not stringified: no targeting clause could use "{tier=gold}".
        context.put("account", Map.of("tier", "gold"));
        context.put("roles", List.of("admin"));
        context.put("nothing", null);

        evaluate("coercion", context)
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.value").isEqualTo(true)
            .jsonPath("$.reason").isEqualTo("TARGETING_MATCH");
    }

    // ---------------------------------------------------------------- helpers

    private static Map<String, Object> context(String targetingKey) {
        return Map.of("targetingKey", targetingKey);
    }

    private static Map<String, Object> context(String targetingKey, Map<String, Object> attributes) {
        Map<String, Object> context = new LinkedHashMap<>(attributes);
        context.put("targetingKey", targetingKey);
        return context;
    }

    private WebTestClient.ResponseSpec evaluate(String flagKey, Map<String, Object> context) {
        return http.post().uri(SINGLE, flagKey)
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(Map.of("context", context))
            .exchange();
    }

    private WebTestClient.ResponseSpec bulk(Map<String, Object> context, String ifNoneMatch) {
        WebTestClient.RequestBodySpec spec = http.post().uri(BULK)
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .contentType(MediaType.APPLICATION_JSON);
        if (ifNoneMatch != null) {
            spec = spec.header(HttpHeaders.IF_NONE_MATCH, ifNoneMatch);
        }
        return spec.bodyValue(Map.of("context", context)).exchange();
    }

    private String rawBody(String flagKey, Map<String, Object> context) {
        return evaluate(flagKey, context).expectBody(String.class).returnResult().getResponseBody();
    }

    private void assertReason(String flagKey, Map<String, Object> context, String ofrep, String switchboard) {
        evaluate(flagKey, context)
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.reason").isEqualTo(ofrep)
            .jsonPath("$.metadata['switchboard.reason']").isEqualTo(switchboard);
    }

    /** Enables the flag with a fixed fallthrough on the variation carrying {@code value}. */
    private void serveFallthrough(FlagDetailResponse flag, String value) {
        UUID served = variationId(flag, value);
        UUID other = flag.getVariations().stream()
            .map(com.switchboard.interfaces.rest.model.Variation::getId)
            .filter(id -> !id.equals(served))
            .findFirst()
            .orElse(served);
        putConfig(flag.getKey(), new FlagTargetingConfig(
            new RolloutOrVariation().variationId(served), other, served), 1);
    }

    private void putConfig(String flagKey, FlagTargetingConfig config, int expectedVersion) {
        http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flagKey, ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new FlagEnvConfigUpdateRequest(true, config).expectedVersion(expectedVersion))
            .exchange()
            .expectStatus().isOk();
    }

    private void killSwitch(String flagKey) {
        http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/kill-switch",
                workspace.projectId(), flagKey, ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new KillSwitchRequest(true).reason("integration test"))
            .exchange()
            .expectStatus().isOk();
    }
}
