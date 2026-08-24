package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.BulkEvalRequest;
import com.switchboard.interfaces.rest.model.EvalContext;
import com.switchboard.interfaces.rest.model.EvalReason;
import com.switchboard.interfaces.rest.model.EvalResult;
import com.switchboard.interfaces.rest.model.FlagCreateRequest;
import com.switchboard.interfaces.rest.model.FlagKind;
import com.switchboard.interfaces.rest.model.SdkKeyCreatedResponse;
import com.switchboard.interfaces.rest.model.SingleEvalRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Two orgs that must not be able to see each other.
 *
 * <p>Both halves of the tenancy boundary are checked: a logged-in user of org A
 * against org B's management routes, and an SDK key - which is scoped to exactly
 * one environment and carries no user identity at all - against both the
 * management surface and another org's flags.
 */
class OrgIsolationIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    private Workspace acme;
    private Workspace beta;

    @BeforeEach
    void seedTwoOrgs() {
        acme = createWorkspace("acme");
        beta = createWorkspace("beta");
        createBooleanFlag(acme, "acme-only");
        createBooleanFlag(beta, "beta-only");
    }

    @Test
    void aMemberOfOneOrgCannotReachAnotherOrgsProject() {
        http.get().uri("/api/projects/{projectId}", acme.projectId())
            .header(HttpHeaders.AUTHORIZATION, beta.authorization())
            .exchange()
            .expectStatus().isForbidden();

        http.get().uri("/api/projects/{projectId}/flags/{flagKey}", acme.projectId(), "acme-only")
            .header(HttpHeaders.AUTHORIZATION, beta.authorization())
            .exchange()
            .expectStatus().isForbidden();

        http.get().uri("/api/projects/{projectId}/flags", acme.projectId())
            .header(HttpHeaders.AUTHORIZATION, beta.authorization())
            .exchange()
            .expectStatus().isForbidden();

        // Writes are refused on the same check, not just reads.
        http.post().uri("/api/projects/{projectId}/flags", acme.projectId())
            .header(HttpHeaders.AUTHORIZATION, beta.authorization())
            .bodyValue(new FlagCreateRequest("intruder", "Intruder", FlagKind.BOOLEAN))
            .exchange()
            .expectStatus().isForbidden();

        // The org itself is 403 too: existence is never leaked.
        http.get().uri("/api/orgs/{orgId}", acme.orgId())
            .header(HttpHeaders.AUTHORIZATION, beta.authorization())
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    void anSdkKeyCannotReachManagementRoutesOrAnotherOrgsFlags() {
        String acmeKey = mintSdkKey(acme, ENV_KEY);

        // ROLE_SDK is not ROLE_USER: the management surface is closed to it.
        http.get().uri("/api/projects/{projectId}/flags", acme.projectId())
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + acmeKey)
            .exchange()
            .expectStatus().isForbidden();
        http.get().uri("/api/orgs")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + acmeKey)
            .exchange()
            .expectStatus().isForbidden();
        http.get().uri("/api/projects/{projectId}/flags", beta.projectId())
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + acmeKey)
            .exchange()
            .expectStatus().isForbidden();

        // The environment comes from the key, never the request: another org's
        // flag is simply not in this environment's snapshot.
        EvalResult crossOrg = http.post().uri("/api/eval/{flagKey}", "beta-only")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + acmeKey)
            .bodyValue(new SingleEvalRequest(new EvalContext("user-1"))._default("not-visible"))
            .exchange()
            .expectStatus().isOk()
            .expectBody(EvalResult.class)
            .returnResult().getResponseBody();
        assertThat(crossOrg.getReason()).isEqualTo(EvalReason.SDK_DEFAULT);
        assertThat(crossOrg.getValue()).isEqualTo("not-visible");

        // A bulk evaluation only ever returns the key's own environment.
        http.post().uri("/api/eval")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + acmeKey)
            .bodyValue(new BulkEvalRequest(new EvalContext("user-1")))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.results.length()").isEqualTo(1)
            .jsonPath("$.results[0].flagKey").isEqualTo("acme-only");
    }

    @Test
    void anUnknownOrRevokedSdkKeyIsUnauthorized() {
        http.post().uri("/api/eval/{flagKey}", "acme-only")
            .header(HttpHeaders.AUTHORIZATION, "Bearer sb_srv_production_deadbeef")
            .bodyValue(new SingleEvalRequest(new EvalContext("user-1"))._default("x"))
            .exchange()
            .expectStatus().isUnauthorized();

        SdkKeyCreatedResponse minted = mintSdkKeyResponse(acme, ENV_KEY);
        http.delete().uri("/api/sdk-keys/{keyId}", minted.getId())
            .header(HttpHeaders.AUTHORIZATION, acme.authorization())
            .exchange()
            .expectStatus().isNoContent();
        http.post().uri("/api/eval/{flagKey}", "acme-only")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + minted.getKey())
            .bodyValue(new SingleEvalRequest(new EvalContext("user-1"))._default("x"))
            .exchange()
            .expectStatus().isUnauthorized();

        // No credentials at all is 401, not 403.
        http.get().uri("/api/eval/bootstrap")
            .exchange()
            .expectStatus().isUnauthorized();
    }
}
