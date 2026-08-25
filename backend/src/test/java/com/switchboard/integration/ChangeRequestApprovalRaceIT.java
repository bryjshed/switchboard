package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.changerequest.ChangeRequestReviewService;
import com.switchboard.domain.changerequest.ChangeRequest;
import com.switchboard.domain.changerequest.ChangeRequestStatus;
import com.switchboard.interfaces.rest.model.ChangeRequestResponse;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.ScopeType;
import com.switchboard.domain.identity.Identities;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Signal;

/**
 * Six approvers hit a threshold of two at the same instant.
 *
 * <p>Two independent things have to hold. Every reviewer's row must be counted,
 * which is what the {@code SELECT ... FOR UPDATE} on the request is for: without
 * it, two transactions under READ COMMITTED each see only their own review and
 * the threshold is never crossed at all. And the crossing must apply exactly
 * once: the compare-and-set out of PENDING lets one caller through, and the
 * partial unique index on {@code created_from_change_request_id} makes a second
 * write impossible even if two instances somehow both got past it.
 */
class ChangeRequestApprovalRaceIT extends IntegrationTestBase {

    private static final int APPROVERS = 6;
    private static final int MIN_APPROVALS = 2;
    private static final String ENV_KEY = "production";

    @Autowired
    private ChangeRequestReviewService reviews;

    @Test
    void concurrentApprovalsCrossingTheThresholdApplyExactlyOnce() {
        Workspace workspace = createWorkspace("approval-race");
        UUID envId = workspace.environmentId(ENV_KEY);
        FlagDetailResponse flag = createBooleanFlag(workspace, "race-flag");
        List<AuthenticatedUser> approvers = IntStream.range(0, APPROVERS)
            .mapToObj(i -> approver(workspace, envId, "race-approver-" + i))
            .toList();

        requireApproval(workspace, ENV_KEY, MIN_APPROVALS, false);
        UUID changeRequestId = openRequest(workspace, flag).getId();

        List<Signal<ChangeRequest>> outcomes = Flux.merge(
                Flux.fromIterable(approvers.stream()
                    .map(user -> reviews.approve(changeRequestId, user, "concurrent").materialize())
                    .map(Mono::flux)
                    .toList()),
                APPROVERS)
            .collectList()
            .block(Duration.ofMinutes(2));

        List<ChangeRequest> succeeded = outcomes.stream()
            .filter(Signal::isOnNext).map(Signal::get).toList();
        // Whoever crossed the threshold is the only caller that can see APPLIED.
        assertThat(succeeded.stream().filter(cr -> cr.status() == ChangeRequestStatus.APPLIED))
            .hasSize(1);

        // The row moved to APPLIED once, and exactly one snapshot claims the request.
        String status = selectOne("SELECT status FROM change_requests WHERE id = :id",
            String.class, Map.of("id", changeRequestId));
        assertThat(status).isEqualTo("APPLIED");

        List<Integer> stamped = selectColumn("""
                SELECT version_number FROM flag_env_config_versions
                WHERE created_from_change_request_id = :id
                """, Integer.class, Map.of("id", changeRequestId));
        assertThat(stamped).containsExactly(2);

        // v1 from flag creation plus the single applied write - nothing double-wrote.
        assertThat(headVersion(flag.getId(), envId)).isEqualTo(2);
        Integer applied = selectOne("SELECT applied_version FROM change_requests WHERE id = :id",
            Integer.class, Map.of("id", changeRequestId));
        assertThat(applied).isEqualTo(2);

        // Every reviewer counts at most once, however the race resolved.
        int reviewRows = selectOne(
            "SELECT count(*)::int FROM change_request_reviews WHERE change_request_id = :id",
            Integer.class, Map.of("id", changeRequestId));
        assertThat(reviewRows).isBetween(MIN_APPROVALS, APPROVERS);
    }

    private AuthenticatedUser approver(Workspace workspace, UUID envId, String prefix) {
        String email = uniqueEmail(prefix);
        UUID userId = provisionUser(email);
        grantRole(workspace, email, ScopeType.ENVIRONMENT, envId, "APPROVER");
        return new AuthenticatedUser(userId, email, Identities.DEV_ISSUER, email);
    }

    private ChangeRequestResponse openRequest(Workspace workspace, FlagDetailResponse flag) {
        return http.put()
            .uri("/api/projects/{projectId}/flags/{flagKey}/environments/{envKey}",
                workspace.projectId(), flag.getKey(), ENV_KEY)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(serveRequest(flag, ENV_KEY, "true", 1))
            .exchange()
            .expectStatus().isAccepted()
            .expectBody(ChangeRequestResponse.class)
            .returnResult().getResponseBody();
    }
}
