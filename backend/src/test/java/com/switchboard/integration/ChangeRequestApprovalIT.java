package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.ApprovalSettingsResponse;
import com.switchboard.interfaces.rest.model.ApprovalSettingsUpdateRequest;
import com.switchboard.interfaces.rest.model.ChangeRequestDecisionRequest;
import com.switchboard.interfaces.rest.model.ChangeRequestKind;
import com.switchboard.interfaces.rest.model.ChangeRequestListResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestStatus;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigResponse;
import com.switchboard.interfaces.rest.model.ScopeType;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * The approval workflow end to end: 202 instead of a write, the threshold, the
 * self-approval rule, staleness, and the kill switch's exemption.
 */
class ChangeRequestApprovalIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";
    private static final String OPEN_ENV_KEY = "dev";

    private Workspace workspace;
    private UUID prodEnvId;
    private String approverEmail;
    private FlagDetailResponse flag;

    @BeforeEach
    void seedApprovalWorkspace() {
        workspace = createWorkspace("approvals");
        prodEnvId = workspace.environmentId(ENV_KEY);
        approverEmail = uniqueEmail("approver");
        grantRole(workspace, approverEmail, ScopeType.ENVIRONMENT, prodEnvId, "APPROVER");
        flag = createBooleanFlag(workspace, "checkout-v2");
    }

    // ---------------------------------------------------------------- defaults

    @Test
    void anEnvironmentStartsWithApprovalOffAndWritesLandImmediately() {
        ApprovalSettingsResponse settings = http.get()
            .uri("/api/environments/{envId}/approval-settings", prodEnvId)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(ApprovalSettingsResponse.class)
            .returnResult().getResponseBody();
        assertThat(settings.getRequireApproval()).isFalse();
        assertThat(settings.getRequireApprovalForKill()).isFalse();
        assertThat(settings.getMinApprovals()).isEqualTo(1);
        assertThat(settings.getAllowSelfApproval()).isFalse();

        write(workspace.authorization(), ENV_KEY, "true", 1).expectStatus().isOk();
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(2);
    }

    // ---------------------------------------------------------------- 202 contract

    @Test
    void anApprovalRequiredWriteAnswers202AndLeavesTheFlagAlone() {
        requireApproval(workspace, ENV_KEY, 1, false);

        ChangeRequestResponse request = write(workspace.authorization(), ENV_KEY, "true", 1)
            .expectStatus().isAccepted()
            .expectHeader().exists("Location")
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        assertThat(request.getStatus()).isEqualTo(ChangeRequestStatus.PENDING);
        assertThat(request.getKind()).isEqualTo(ChangeRequestKind.TARGETING_UPDATE);
        assertThat(request.getBaseVersion()).isEqualTo(1);
        assertThat(request.getApprovalsMet()).isZero();
        assertThat(request.getRequestedBy()).isEqualTo(workspace.ownerEmail());

        // Nothing was written: no version, no state bump for the SDK stream.
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(1);
        assertThat(versionCount(flag.getId(), prodEnvId)).isEqualTo(1);

        // Other environments are untouched by production's policy.
        write(workspace.authorization(), OPEN_ENV_KEY, "true", 1).expectStatus().isOk();
    }

    @Test
    void reachingTheThresholdAppliesThroughTheNormalVersionedWritePath() {
        requireApproval(workspace, ENV_KEY, 1, false);
        ChangeRequestResponse pending = openRequest("true", 1);

        ChangeRequestResponse applied = approve(approverEmail, pending.getId(), "ship it")
            .expectStatus().isOk()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        assertThat(applied.getStatus()).isEqualTo(ChangeRequestStatus.APPLIED);
        assertThat(applied.getAppliedVersion()).isEqualTo(2);
        assertThat(applied.getApprovalsMet()).isEqualTo(1);
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(2);

        // The snapshot is stamped with the request, which is the double-apply backstop.
        List<UUID> stamped = selectColumn("""
                SELECT created_from_change_request_id FROM flag_env_config_versions
                WHERE flag_id = :flagId AND environment_id = :envId
                  AND created_from_change_request_id IS NOT NULL
                """, UUID.class, Map.of("flagId", flag.getId(), "envId", prodEnvId));
        assertThat(stamped).containsExactly(pending.getId());

        // The audit row says it came from a change request and names the approver.
        String action = selectOne("""
                SELECT action FROM audit_entries
                WHERE environment_id = :envId AND flag_key = :flagKey
                ORDER BY created_at DESC LIMIT 1
                """, String.class, Map.of("envId", prodEnvId, "flagKey", flag.getKey()));
        assertThat(action).isEqualTo("CHANGE_REQUEST_APPLY");
        String reason = selectOne("""
                SELECT reason FROM audit_entries
                WHERE environment_id = :envId AND flag_key = :flagKey AND action = 'CHANGE_REQUEST_APPLY'
                ORDER BY created_at DESC LIMIT 1
                """, String.class, Map.of("envId", prodEnvId, "flagKey", flag.getKey()));
        assertThat(reason).contains("approved by " + approverEmail);
        assertThat(reason).contains(pending.getId().toString());

        // And the opening of the request was audited too.
        List<String> actions = selectColumn("""
                SELECT action FROM audit_entries
                WHERE environment_id = :envId AND flag_key = :flagKey
                ORDER BY created_at
                """, String.class, Map.of("envId", prodEnvId, "flagKey", flag.getKey()));
        assertThat(actions).contains("CHANGE_REQUEST_OPEN", "CHANGE_REQUEST_APPLY");
    }

    @Test
    void twoApprovalsAreNeededWhenTheThresholdIsTwo() {
        String secondApprover = uniqueEmail("approver2");
        grantRole(workspace, secondApprover, ScopeType.ENVIRONMENT, prodEnvId, "APPROVER");
        requireApproval(workspace, ENV_KEY, 2, false);
        ChangeRequestResponse pending = openRequest("true", 1);

        ChangeRequestResponse afterFirst = approve(approverEmail, pending.getId(), "one")
            .expectStatus().isOk()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();
        assertThat(afterFirst.getStatus()).isEqualTo(ChangeRequestStatus.PENDING);
        assertThat(afterFirst.getApprovalsMet()).isEqualTo(1);
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(1);

        ChangeRequestResponse afterSecond = approve(secondApprover, pending.getId(), "two")
            .expectStatus().isOk()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();
        assertThat(afterSecond.getStatus()).isEqualTo(ChangeRequestStatus.APPLIED);
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(2);
    }

    // ---------------------------------------------------------------- self-approval

    @Test
    void selfApprovalIsRefusedByDefaultAndAllowedWhenConfigured() {
        requireApproval(workspace, ENV_KEY, 1, false);
        ChangeRequestResponse pending = openRequest("true", 1);

        approve(workspace.ownerEmail(), pending.getId(), "my own change")
            .expectStatus().isForbidden();
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(1);

        // Turning it on lets the author carry their own change - and the change
        // request keeps the policy it was opened under, so this one still refuses.
        setApprovalSettings(workspace, ENV_KEY,
            new ApprovalSettingsUpdateRequest().allowSelfApproval(true));
        approve(workspace.ownerEmail(), pending.getId(), "still refused")
            .expectStatus().isForbidden();

        // A request opened after the change carries the new policy.
        ChangeRequestResponse selfApprovable = openRequest("true", 1);
        assertThat(selfApprovable.getAllowSelfApproval()).isTrue();
        ChangeRequestResponse applied = approve(workspace.ownerEmail(), selfApprovable.getId(), "mine")
            .expectStatus().isOk()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();
        assertThat(applied.getStatus()).isEqualTo(ChangeRequestStatus.APPLIED);
    }

    // ---------------------------------------------------------------- staleness

    @Test
    void aRequestWhoseFlagMovedGoesStaleInsteadOfClobbering() {
        requireApproval(workspace, ENV_KEY, 1, false);
        ChangeRequestResponse first = openRequest("true", 1);
        ChangeRequestResponse second = openRequest("false", 1);
        assertThat(second.getBaseVersion()).isEqualTo(1);

        approve(approverEmail, first.getId(), "first wins")
            .expectStatus().isOk()
            .expectBody(ChangeRequestResponse.class);
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(2);

        ChangeRequestResponse stale = approve(approverEmail, second.getId(), "too late")
            .expectStatus().isOk()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        assertThat(stale.getStatus()).isEqualTo(ChangeRequestStatus.STALE);
        assertThat(stale.getAppliedVersion()).isNull();
        // The winner's write is intact: the stale request did not overwrite it.
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(2);
        assertThat(servedVariationValue()).isEqualTo("true");
    }

    // ---------------------------------------------------------------- kill switch

    @Test
    void theKillSwitchBypassesApprovalByDefaultAndRespectsTheOptIn() {
        requireApproval(workspace, ENV_KEY, 1, false);

        // Emergency stop still lands immediately in an approval-required environment.
        killSwitch(true).expectStatus().isOk();
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(2);
        assertThat(killSwitchActive()).isTrue();
        killSwitch(false).expectStatus().isOk();
        assertThat(killSwitchActive()).isFalse();

        // Opting in puts it behind review like everything else.
        setApprovalSettings(workspace, ENV_KEY,
            new ApprovalSettingsUpdateRequest().requireApprovalForKill(true));
        int before = headVersion(flag.getId(), prodEnvId);
        ChangeRequestResponse pending = killSwitch(true)
            .expectStatus().isAccepted()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();
        assertThat(pending.getKind()).isEqualTo(ChangeRequestKind.KILL_SWITCH);
        assertThat(pending.getPayload().getActive()).isTrue();
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(before);

        approve(approverEmail, pending.getId(), "reviewed stop").expectStatus().isOk();
        assertThat(killSwitchActive()).isTrue();
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(before + 1);

        // requireApprovalForKill on its own does nothing when approvals are off.
        setApprovalSettings(workspace, ENV_KEY,
            new ApprovalSettingsUpdateRequest().requireApproval(false));
        killSwitch(false).expectStatus().isOk();
        assertThat(killSwitchActive()).isFalse();
    }

    // ---------------------------------------------------------------- lifecycle

    @Test
    void declineWithdrawAndTheListingBehaveAsDocumented() {
        requireApproval(workspace, ENV_KEY, 1, false);
        ChangeRequestResponse declined = openRequest("true", 1);
        ChangeRequestResponse withdrawn = openRequest("false", 1);

        http.post().uri("/api/change-requests/{id}/decline", declined.getId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approverEmail))
            .bodyValue(new ChangeRequestDecisionRequest().comment("not now"))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.status").isEqualTo("DECLINED");

        // A declined request cannot be revived by approving it.
        approve(approverEmail, declined.getId(), "changed my mind").expectStatus().isEqualTo(409);

        // Only the author may withdraw.
        http.post().uri("/api/change-requests/{id}/withdraw", withdrawn.getId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approverEmail))
            .exchange()
            .expectStatus().isForbidden();
        http.post().uri("/api/change-requests/{id}/withdraw", withdrawn.getId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.status").isEqualTo("WITHDRAWN");

        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(1);

        ChangeRequestListResponse all = http.get()
            .uri("/api/projects/{projectId}/change-requests?envKey={envKey}&flagKey={flagKey}",
                workspace.projectId(), ENV_KEY, flag.getKey())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(ChangeRequestListResponse.class)
            .returnResult().getResponseBody();
        assertThat(all.getItems()).hasSize(2);

        ChangeRequestListResponse onlyDeclined = http.get()
            .uri("/api/projects/{projectId}/change-requests?status=DECLINED", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(ChangeRequestListResponse.class)
            .returnResult().getResponseBody();
        assertThat(onlyDeclined.getItems()).extracting("id").containsExactly(declined.getId());
    }

    @Test
    void applyRefusesAnythingThatIsNotAlreadyApproved() {
        requireApproval(workspace, ENV_KEY, 1, false);
        ChangeRequestResponse pending = openRequest("true", 1);

        http.post().uri("/api/change-requests/{id}/apply", pending.getId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approverEmail))
            .exchange()
            .expectStatus().isEqualTo(409);
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(1);

        // Once applied, a retry is a conflict rather than a second write.
        approve(approverEmail, pending.getId(), "go").expectStatus().isOk();
        http.post().uri("/api/change-requests/{id}/apply", pending.getId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approverEmail))
            .exchange()
            .expectStatus().isEqualTo(409);
        assertThat(headVersion(flag.getId(), prodEnvId)).isEqualTo(2);
    }

    @Test
    void aStaleExpectedVersionIsRefusedBeforeARequestIsEverOpened() {
        requireApproval(workspace, ENV_KEY, 1, false);
        write(workspace.authorization(), ENV_KEY, "true", 99).expectStatus().isEqualTo(409);
        assertThat(countRequests()).isZero();
    }

    // ---------------------------------------------------------------- helpers

    private WebTestClient.ResponseSpec write(
        String authorization, String envKey, String value, Integer expectedVersion) {
        return http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), envKey)
            .header(HttpHeaders.AUTHORIZATION, authorization)
            .bodyValue(serveRequest(flag, envKey, value, expectedVersion))
            .exchange();
    }

    private ChangeRequestResponse openRequest(String value, Integer expectedVersion) {
        return write(workspace.authorization(), ENV_KEY, value, expectedVersion)
            .expectStatus().isAccepted()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();
    }

    private WebTestClient.ResponseSpec approve(String email, UUID changeRequestId, String comment) {
        return http.post().uri("/api/change-requests/{id}/approve", changeRequestId)
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .bodyValue(new ChangeRequestDecisionRequest().comment(comment))
            .exchange();
    }

    private WebTestClient.ResponseSpec killSwitch(boolean active) {
        return http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/kill-switch",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("active", active, "reason", "incident drill"))
            .exchange();
    }

    private int versionCount(UUID flagId, UUID environmentId) {
        return selectOne("""
                SELECT count(*)::int FROM flag_env_config_versions
                WHERE flag_id = :flagId AND environment_id = :envId
                """, Integer.class, Map.of("flagId", flagId, "envId", environmentId));
    }

    private int countRequests() {
        return selectOne("SELECT count(*)::int FROM change_requests WHERE flag_id = :flagId",
            Integer.class, Map.of("flagId", flag.getId()));
    }

    private boolean killSwitchActive() {
        return selectOne("""
                SELECT kill_switch_active FROM flag_env_configs
                WHERE flag_id = :flagId AND environment_id = :envId
                """, Boolean.class, Map.of("flagId", flag.getId(), "envId", prodEnvId));
    }

    /** The variation the production head serves through its fallthrough. */
    private String servedVariationValue() {
        FlagDetailResponse current = http.get()
            .uri("/api/projects/{projectId}/flags/{flagKey}", workspace.projectId(), flag.getKey())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(FlagDetailResponse.class)
            .returnResult().getResponseBody();
        FlagEnvConfigResponse config = envConfig(current, ENV_KEY);
        UUID served = config.getConfig().getFallthrough().getVariationId();
        return current.getVariations().stream()
            .filter(variation -> variation.getId().equals(served))
            .findFirst()
            .orElseThrow()
            .getValue();
    }
}
