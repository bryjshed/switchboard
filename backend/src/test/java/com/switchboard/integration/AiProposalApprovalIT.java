package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.ai.ProposalActor;
import com.switchboard.application.ai.ProposalService;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.EnvChange;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.ai.TargetingDraft;
import com.switchboard.domain.ai.ValueServe;
import com.switchboard.interfaces.rest.model.ChangeRequestDecisionRequest;
import com.switchboard.interfaces.rest.model.ChangeRequestResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestStatus;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.KillSwitchRequest;
import com.switchboard.interfaces.rest.model.ProposalActionRequest;
import com.switchboard.interfaces.rest.model.ScopeType;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * The governance hole this suite exists to keep closed: an AI proposal used to
 * call FlagTargetingService directly, so applying one in an environment with
 * require_approval on wrote straight past the review queue.
 *
 * <p>An apply is a flag write, so it now answers to exactly the policy a hand
 * edit does - 202 and a PENDING change request in a gated environment, 200 and a
 * version in an ungated one - and the proposal only reaches APPLIED because a
 * human approved the request that stands in for it.
 */
class AiProposalApprovalIT extends IntegrationTestBase {

    private static final String GATED_ENV = "production";
    private static final String OPEN_ENV = "staging";

    @Autowired
    private ProposalService proposals;

    // ---------------------------------------------------------------- (a) parked

    @Test
    void applyingInAGatedEnvironmentOpensAStampedRequestAndWritesNothing() {
        Workspace workspace = createWorkspace("ai-gated");
        FlagDetailResponse flag = createStringFlag(
            workspace, "checkout-copy", List.of("control", "treatment"));
        requireApproval(workspace, GATED_ENV, 1, false);
        AiProposal draft = insertDraft(workspace, flag.getKey(), GATED_ENV, "control");

        UUID environmentId = workspace.environmentId(GATED_ENV);
        int versionBefore = headVersion(flag.getId(), environmentId);
        String configBefore = configJson(flag.getId(), environmentId);

        ChangeRequestResponse parked = applyOverHttp(workspace, draft.id())
            .expectStatus().isAccepted()
            .expectHeader().exists(HttpHeaders.LOCATION)
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        // The request exists, is PENDING, and says which proposal caused it.
        assertThat(parked.getStatus()).isEqualTo(ChangeRequestStatus.PENDING);
        assertThat(parked.getAiProposalId()).isEqualTo(draft.id());
        assertThat(parked.getEnvKey()).isEqualTo(GATED_ENV);
        assertThat(parked.getFlagKey()).isEqualTo(flag.getKey());
        // The payload is the RESOLVED config a reviewer will approve, not the draft.
        assertThat(parked.getPayload().getConfig().getFallthrough().getVariationId())
            .isEqualTo(variationId(flag, "control"));

        // Nothing was written.
        assertThat(headVersion(flag.getId(), environmentId)).isEqualTo(versionBefore);
        assertThat(configJson(flag.getId(), environmentId)).isEqualTo(configBefore);
        assertThat(versionsStampedWithProposal(draft.id())).isEmpty();

        // And the proposal has NOT been applied.
        assertThat(proposalStatus(draft.id())).isEqualTo("DRAFT");
        assertThat(appliedVersion(draft.id())).isEqualTo(-1);

        // The open is audited with the proposal's provenance on it.
        assertThat(selectOne("""
                SELECT diff FROM audit_entries
                WHERE environment_id = :envId AND action = 'CHANGE_REQUEST_OPEN'
                """, String.class, Map.of("envId", environmentId)))
            .contains(draft.id().toString());
    }

    /** A second apply cannot quietly open a second queue entry for the same write. */
    @Test
    void applyingTwiceWhileTheRequestIsPendingIsRefused() {
        Workspace workspace = createWorkspace("ai-gated-twice");
        FlagDetailResponse flag = createStringFlag(
            workspace, "double-park", List.of("control", "treatment"));
        requireApproval(workspace, GATED_ENV, 1, false);
        AiProposal draft = insertDraft(workspace, flag.getKey(), GATED_ENV, "control");

        applyOverHttp(workspace, draft.id()).expectStatus().isAccepted();
        applyOverHttp(workspace, draft.id()).expectStatus().isEqualTo(409);

        assertThat(openRequestCount(draft.id())).isEqualTo(1);
        assertThat(proposalStatus(draft.id())).isEqualTo("DRAFT");
    }

    // ---------------------------------------------------------------- (b) approved

    @Test
    void approvingTheRequestAppliesItAndSettlesTheProposal() {
        Workspace workspace = createWorkspace("ai-approved");
        FlagDetailResponse flag = createStringFlag(
            workspace, "payments-copy", List.of("control", "treatment"));
        requireApproval(workspace, GATED_ENV, 1, false);
        String approver = uniqueEmail("ai-approver");
        grantRole(workspace, approver, ScopeType.ENVIRONMENT, workspace.environmentId(GATED_ENV),
            "APPROVER");
        AiProposal draft = insertDraft(workspace, flag.getKey(), GATED_ENV, "control");

        UUID environmentId = workspace.environmentId(GATED_ENV);
        int versionBefore = headVersion(flag.getId(), environmentId);

        ChangeRequestResponse parked = applyOverHttp(workspace, draft.id())
            .expectStatus().isAccepted()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        ChangeRequestResponse applied = http.post()
            .uri("/api/change-requests/{id}/approve", parked.getId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approver))
            .bodyValue(new ChangeRequestDecisionRequest().comment("looks right"))
            .exchange()
            .expectStatus().isOk()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        assertThat(applied.getStatus()).isEqualTo(ChangeRequestStatus.APPLIED);

        // The flag moved, once.
        int versionAfter = headVersion(flag.getId(), environmentId);
        assertThat(versionAfter).isEqualTo(versionBefore + 1);
        assertThat(fallthroughVariation(flag.getId(), environmentId))
            .isEqualTo(variationId(flag, "control").toString());
        assertThat(applied.getAppliedVersion()).isEqualTo(versionAfter);

        // The proposal settled exactly as a direct apply leaves it.
        assertThat(proposalStatus(draft.id())).isEqualTo("APPLIED");
        assertThat(appliedVersion(draft.id())).isEqualTo(versionAfter);

        // The audit names the approver AND the proposal behind the change.
        String reason = selectOne("""
            SELECT reason FROM audit_entries
            WHERE environment_id = :envId AND action = 'CHANGE_REQUEST_APPLY'
            """, String.class, Map.of("envId", environmentId));
        assertThat(reason).contains(approver).contains(draft.id().toString());

        // Provenance survives on the version snapshot too: it is stamped with the
        // change request, which carries the proposal id.
        UUID stampedRequest = selectOne("""
            SELECT created_from_change_request_id FROM flag_env_config_versions
            WHERE flag_id = :flagId AND environment_id = :envId AND version_number = :version
            """, UUID.class,
            Map.of("flagId", flag.getId(), "envId", environmentId, "version", versionAfter));
        assertThat(stampedRequest).isEqualTo(parked.getId());
    }

    // ---------------------------------------------------------------- (c) ungated

    @Test
    void applyingInAnUngatedEnvironmentBehavesExactlyAsBefore() {
        Workspace workspace = createWorkspace("ai-open");
        FlagDetailResponse flag = createStringFlag(
            workspace, "search-copy", List.of("control", "treatment"));
        // Production is gated; staging, which this proposal targets, is not.
        requireApproval(workspace, GATED_ENV, 1, false);
        AiProposal draft = insertDraft(workspace, flag.getKey(), OPEN_ENV, "control");

        UUID environmentId = workspace.environmentId(OPEN_ENV);
        int versionBefore = headVersion(flag.getId(), environmentId);

        applyOverHttp(workspace, draft.id())
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.status").isEqualTo("APPLIED");

        int versionAfter = headVersion(flag.getId(), environmentId);
        assertThat(versionAfter).isEqualTo(versionBefore + 1);
        assertThat(proposalStatus(draft.id())).isEqualTo("APPLIED");
        assertThat(appliedVersion(draft.id())).isEqualTo(versionAfter);
        // The old write path, unchanged: the version snapshot carries the proposal
        // stamp itself and no change request was involved at all.
        assertThat(versionsStampedWithProposal(draft.id())).containsExactly(versionAfter);
        assertThat(requestCount(draft.id())).isZero();
        assertThat(selectOne("""
                SELECT count(*) FROM audit_entries
                WHERE environment_id = :envId AND action = 'AI_APPLY'
                """, Long.class, Map.of("envId", environmentId)))
            .isEqualTo(1);
    }

    // ---------------------------------------------------------------- (f) declined / stale

    @Test
    void aDeclinedRequestLeavesTheProposalDraftAndRetryable() {
        Workspace workspace = createWorkspace("ai-declined");
        FlagDetailResponse flag = createStringFlag(
            workspace, "declined-copy", List.of("control", "treatment"));
        requireApproval(workspace, GATED_ENV, 1, false);
        String approver = uniqueEmail("ai-decliner");
        grantRole(workspace, approver, ScopeType.ENVIRONMENT, workspace.environmentId(GATED_ENV),
            "APPROVER");
        AiProposal draft = insertDraft(workspace, flag.getKey(), GATED_ENV, "control");

        UUID environmentId = workspace.environmentId(GATED_ENV);
        int versionBefore = headVersion(flag.getId(), environmentId);

        ChangeRequestResponse parked = applyOverHttp(workspace, draft.id())
            .expectStatus().isAccepted()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        http.post().uri("/api/change-requests/{id}/decline", parked.getId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approver))
            .bodyValue(new ChangeRequestDecisionRequest().comment("not now"))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.status").isEqualTo("DECLINED");

        // DRAFT, untouched, and nothing was written.
        assertThat(proposalStatus(draft.id())).isEqualTo("DRAFT");
        assertThat(appliedVersion(draft.id())).isEqualTo(-1);
        assertThat(headVersion(flag.getId(), environmentId)).isEqualTo(versionBefore);

        // Retryable: a decline releases the one-open-request-per-environment lock.
        ChangeRequestResponse reopened = applyOverHttp(workspace, draft.id())
            .expectStatus().isAccepted()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();
        assertThat(reopened.getId()).isNotEqualTo(parked.getId());
        assertThat(reopened.getAiProposalId()).isEqualTo(draft.id());
    }

    @Test
    void aStaleRequestLeavesTheProposalDraft() {
        Workspace workspace = createWorkspace("ai-stale");
        FlagDetailResponse flag = createStringFlag(
            workspace, "stale-copy", List.of("control", "treatment"));
        requireApproval(workspace, GATED_ENV, 1, false);
        String approver = uniqueEmail("ai-stale-approver");
        grantRole(workspace, approver, ScopeType.ENVIRONMENT, workspace.environmentId(GATED_ENV),
            "APPROVER");
        AiProposal draft = insertDraft(workspace, flag.getKey(), GATED_ENV, "control");

        ChangeRequestResponse parked = applyOverHttp(workspace, draft.id())
            .expectStatus().isAccepted()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();

        // The head moves under the pending request. The kill switch is the one
        // write that is not itself gated, so it can do this without a review.
        http.post()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}/kill-switch",
                workspace.projectId(), flag.getKey(), GATED_ENV)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new KillSwitchRequest(true).reason("incident"))
            .exchange()
            .expectStatus().isOk();

        http.post().uri("/api/change-requests/{id}/approve", parked.getId())
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(approver))
            .bodyValue(new ChangeRequestDecisionRequest())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.status").isEqualTo("STALE");

        assertThat(proposalStatus(draft.id())).isEqualTo("DRAFT");
        assertThat(appliedVersion(draft.id())).isEqualTo(-1);
        assertThat(versionsStampedWithProposal(draft.id())).isEmpty();
    }

    // ---------------------------------------------------------------- helpers

    private WebTestClient.ResponseSpec applyOverHttp(Workspace workspace, UUID proposalId) {
        return http.post().uri("/api/ai/proposals/{proposalId}/apply", proposalId)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new ProposalActionRequest().reason("apply the proposal"))
            .exchange();
    }

    /**
     * A DRAFT built by hand rather than by the model: the Noop assistant refuses
     * to draft without an API key, and what is under test is the apply path.
     */
    private AiProposal insertDraft(Workspace workspace, String flagKey, String envKey, String value) {
        TargetingDraft targeting = new TargetingDraft(
            null, null, ValueServe.ofValue(value), null, null);
        FlagChangeDiff diff = new FlagChangeDiff(
            ProposalKind.FLAG_UPDATE, flagKey, null, null, null,
            List.of(), List.of(),
            List.of(new EnvChange(envKey, true, null, targeting)),
            null, List.of());
        return proposals.insertDraft(new AiProposal(
                null, workspace.orgId(), workspace.projectId(), workspace.environmentId(envKey),
                ProposalKind.FLAG_UPDATE, "serve " + value + " to everyone", diff,
                value + " is the known-good variation", ProposalStatus.DRAFT,
                workspace.ownerEmail(), null, null, null))
            .block(DB_TIMEOUT);
    }

    private String proposalStatus(UUID proposalId) {
        return selectOne("SELECT status FROM ai_proposals WHERE id = :id",
            String.class, Map.of("id", proposalId));
    }

    /** -1 stands in for "not applied", because selectOne cannot carry a SQL NULL. */
    private int appliedVersion(UUID proposalId) {
        return selectOne("SELECT coalesce(applied_version, -1) FROM ai_proposals WHERE id = :id",
            Integer.class, Map.of("id", proposalId));
    }

    private List<Integer> versionsStampedWithProposal(UUID proposalId) {
        return selectColumn("""
            SELECT version_number FROM flag_env_config_versions
            WHERE created_from_proposal_id = :id ORDER BY version_number
            """, Integer.class, Map.of("id", proposalId));
    }

    private long requestCount(UUID proposalId) {
        return selectOne("SELECT count(*) FROM change_requests WHERE ai_proposal_id = :id",
            Long.class, Map.of("id", proposalId));
    }

    private long openRequestCount(UUID proposalId) {
        return selectOne("""
            SELECT count(*) FROM change_requests
            WHERE ai_proposal_id = :id AND status IN ('PENDING', 'APPROVED')
            """, Long.class, Map.of("id", proposalId));
    }

    private String fallthroughVariation(UUID flagId, UUID environmentId) {
        return selectOne("""
            SELECT coalesce(config #>> '{fallthrough,variationId}', '') FROM flag_env_configs
            WHERE flag_id = :flagId AND environment_id = :envId
            """, String.class, Map.of("flagId", flagId, "envId", environmentId));
    }

    /** The whole stored config, for "nothing about this flag moved" assertions. */
    private String configJson(UUID flagId, UUID environmentId) {
        return selectOne("""
            SELECT config::text FROM flag_env_configs
            WHERE flag_id = :flagId AND environment_id = :envId
            """, String.class, Map.of("flagId", flagId, "envId", environmentId));
    }
}
