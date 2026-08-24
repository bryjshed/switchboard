package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.ai.ProposalActor;
import com.switchboard.application.ai.ProposalOutcome;
import com.switchboard.application.ai.ProposalService;
import com.switchboard.domain.ai.AiProposal;
import com.switchboard.domain.ai.EnvChange;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.ProposalStatus;
import com.switchboard.domain.ai.TargetingDraft;
import com.switchboard.domain.ai.ValueServe;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.ProposalActionRequest;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Signal;

/**
 * Ten callers apply the same DRAFT proposal at once.
 *
 * <p>Exactly one may win. The compare-and-set out of DRAFT is the fast path and
 * the partial unique index on {@code created_from_proposal_id} is the backstop,
 * and because the CAS shares a transaction with the writes it authorises, a
 * loser must leave no trace at all: no second version snapshot carrying the
 * proposal id, no second head bump, no second APPLIED stamp.
 */
class ProposalDoubleApplyRaceIT extends IntegrationTestBase {

    private static final int CONCURRENT_APPLIES = 10;
    private static final String ENV_KEY = "production";

    @Autowired
    private ProposalService proposals;

    @Test
    void exactlyOneOfTenConcurrentAppliesWins() {
        Workspace workspace = createWorkspace("double-apply");
        FlagDetailResponse flag = createStringFlag(
            workspace, "checkout-copy", List.of("control", "treatment"));
        AiProposal draft = insertDraft(workspace, flag.getKey());

        ProposalActor actor = new ProposalActor(workspace.ownerId(), workspace.ownerEmail());
        List<Mono<Signal<ProposalOutcome>>> applies = IntStream.range(0, CONCURRENT_APPLIES)
            .mapToObj(i -> proposals.apply(draft.id(), actor, "concurrent apply " + i).materialize())
            .toList();

        List<Signal<ProposalOutcome>> outcomes = Flux.merge(Flux.fromIterable(applies), CONCURRENT_APPLIES)
            .collectList()
            .block(Duration.ofMinutes(2));

        List<AiProposal> applied = outcomes.stream()
            .filter(Signal::isOnNext).map(signal -> signal.get().proposal()).toList();
        List<Throwable> rejected = outcomes.stream()
            .filter(Signal::isOnError).map(Signal::getThrowable).toList();

        assertThat(applied).hasSize(1);
        assertThat(applied.get(0).status()).isEqualTo(ProposalStatus.APPLIED);
        assertThat(rejected).hasSize(CONCURRENT_APPLIES - 1);
        assertThat(rejected).allSatisfy(error -> assertThat(error).isInstanceOf(ConflictException.class));

        // The row itself ended APPLIED exactly once, stamped by exactly one actor.
        String status = selectOne("SELECT status FROM ai_proposals WHERE id = :id",
            String.class, Map.of("id", draft.id()));
        assertThat(status).isEqualTo("APPLIED");
        String appliedBy = selectOne("SELECT applied_by FROM ai_proposals WHERE id = :id",
            String.class, Map.of("id", draft.id()));
        assertThat(appliedBy).isEqualTo(workspace.ownerEmail());

        // The backstop index: one and only one snapshot may claim the proposal.
        List<Integer> stamped = selectColumn("""
                SELECT version_number FROM flag_env_config_versions
                WHERE created_from_proposal_id = :id
                """, Integer.class, Map.of("id", draft.id()));
        assertThat(stamped).containsExactly(2);

        // v1 from flag creation plus the single applied write.
        Integer headVersion = selectOne("""
                SELECT version FROM flag_env_configs
                WHERE flag_id = :flagId AND environment_id = :envId
                """, Integer.class,
            Map.of("flagId", flag.getId(), "envId", workspace.environmentId(ENV_KEY)));
        assertThat(headVersion).isEqualTo(2);
    }

    @Test
    void reapplyingAnAppliedProposalOverHttpIsA409() {
        Workspace workspace = createWorkspace("reapply");
        FlagDetailResponse flag = createStringFlag(
            workspace, "reapply-copy", List.of("control", "treatment"));
        AiProposal draft = insertDraft(workspace, flag.getKey());

        applyOverHttp(workspace, draft.id()).expectStatus().isOk();
        applyOverHttp(workspace, draft.id()).expectStatus().isEqualTo(409);
    }

    private WebTestClient.ResponseSpec applyOverHttp(Workspace workspace, UUID proposalId) {
        return http.post().uri("/api/ai/proposals/{proposalId}/apply", proposalId)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new ProposalActionRequest().reason("apply"))
            .exchange();
    }

    /**
     * A DRAFT built by hand rather than by the model: the Noop assistant refuses
     * to draft without an API key, and what is under test is the apply path.
     */
    private AiProposal insertDraft(Workspace workspace, String flagKey) {
        TargetingDraft targeting = new TargetingDraft(
            null, null, ValueServe.ofValue("control"), null, null);
        FlagChangeDiff diff = new FlagChangeDiff(
            ProposalKind.FLAG_UPDATE, flagKey, null, null, null,
            List.of(), List.of(),
            List.of(new EnvChange(ENV_KEY, true, null, targeting)),
            null, List.of());
        return proposals.insertDraft(new AiProposal(
                null, workspace.orgId(), workspace.projectId(), workspace.environmentId(ENV_KEY),
                ProposalKind.FLAG_UPDATE, "serve control to everyone", diff,
                "Control is the known-good variation", ProposalStatus.DRAFT,
                workspace.ownerEmail(), null, null, null))
            .block(DB_TIMEOUT);
    }
}
