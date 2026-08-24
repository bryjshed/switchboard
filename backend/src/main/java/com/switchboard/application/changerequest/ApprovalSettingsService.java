package com.switchboard.application.changerequest;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.org.EnvironmentAccess;
import com.switchboard.domain.project.ApprovalSettings;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/**
 * Reads and writes one environment's approval policy.
 *
 * <p>Reading needs only FLAG_READ, because the dashboard has to be able to tell a
 * writer that their edit will open a review rather than land. Changing the policy
 * needs MANAGE_ENVIRONMENTS, which the built-in OWNER and ADMIN roles hold and
 * nothing else does.
 */
@Service
public class ApprovalSettingsService {

    private final EnvironmentRepository environments;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final TransactionalOperator tx;

    public ApprovalSettingsService(
        EnvironmentRepository environments,
        OrgAccessService access,
        AuditWriter audit,
        TransactionalOperator tx) {
        this.environments = environments;
        this.access = access;
        this.audit = audit;
        this.tx = tx;
    }

    public Mono<ApprovalSettings> get(UUID environmentId, UUID userId) {
        return access.requireEnvironmentPermission(environmentId, userId, Permission.FLAG_READ)
            .then(load(environmentId))
            .map(Environment::approvals);
    }

    /** PATCH semantics on a PUT body: an omitted field keeps its stored value. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<ApprovalSettings> update(
        UUID environmentId, AuthenticatedUser caller, Boolean requireApproval, Integer minApprovals,
        Boolean allowSelfApproval, Boolean requireApprovalForKill, Boolean allowAutomationBypass) {

        return access.requireEnvironmentPermission(
                environmentId, caller.userId(), Permission.MANAGE_ENVIRONMENTS)
            .flatMap(envAccess -> load(environmentId)
                .flatMap(env -> {
                    ApprovalSettings merged = merge(
                        env.approvals(), requireApproval, minApprovals,
                        allowSelfApproval, requireApprovalForKill, allowAutomationBypass);
                    return environments.updateApprovalSettings(environmentId, merged)
                        .then(auditChange(envAccess, caller, merged))
                        .thenReturn(merged);
                })
                .as(tx::transactional));
    }

    private Mono<Void> auditChange(
        EnvironmentAccess envAccess, AuthenticatedUser caller, ApprovalSettings merged) {
        String summary = "approvals " + (merged.requireApproval() ? "on" : "off")
            + ", minApprovals=" + merged.minApprovals()
            + ", allowSelfApproval=" + merged.allowSelfApproval()
            + ", requireApprovalForKill=" + merged.requireApprovalForKill()
            + ", allowAutomationBypass=" + merged.allowAutomationBypass();
        return audit.insert(
            envAccess.orgId(), envAccess.projectId(), envAccess.environmentId(), null,
            "SETTINGS_UPDATE", caller.email(), summary, null, null, null);
    }

    private static ApprovalSettings merge(
        ApprovalSettings current, Boolean requireApproval, Integer minApprovals,
        Boolean allowSelfApproval, Boolean requireApprovalForKill, Boolean allowAutomationBypass) {
        int approvals = minApprovals == null ? current.minApprovals() : minApprovals;
        if (approvals < 1 || approvals > 10) {
            throw new ValidationException("minApprovals must be between 1 and 10");
        }
        return new ApprovalSettings(
            requireApproval == null ? current.requireApproval() : requireApproval,
            approvals,
            allowSelfApproval == null ? current.allowSelfApproval() : allowSelfApproval,
            requireApprovalForKill == null ? current.requireApprovalForKill() : requireApprovalForKill,
            allowAutomationBypass == null ? current.allowAutomationBypass() : allowAutomationBypass);
    }

    private Mono<Environment> load(UUID environmentId) {
        return environments.findById(environmentId)
            .switchIfEmpty(Mono.error(new NotFoundException("Environment not found")));
    }
}
