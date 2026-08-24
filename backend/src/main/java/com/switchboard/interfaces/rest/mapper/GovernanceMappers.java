package com.switchboard.interfaces.rest.mapper;

import com.switchboard.domain.access.RoleAssignment;
import com.switchboard.domain.access.RoleDefinition;
import com.switchboard.domain.changerequest.ChangeRequest;
import com.switchboard.domain.changerequest.ChangeRequestReview;
import com.switchboard.domain.project.ApprovalSettings;
import com.switchboard.interfaces.rest.model.ApprovalSettingsResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestKind;
import com.switchboard.interfaces.rest.model.ChangeRequestPayload;
import com.switchboard.interfaces.rest.model.ChangeRequestResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestReviewResponse;
import com.switchboard.interfaces.rest.model.ChangeRequestStatus;
import com.switchboard.interfaces.rest.model.Permission;
import com.switchboard.interfaces.rest.model.ReviewDecision;
import com.switchboard.interfaces.rest.model.RoleAssignmentResponse;
import com.switchboard.interfaces.rest.model.RoleResponse;
import com.switchboard.interfaces.rest.model.ScopeType;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;

/** Domain to generated REST model mapping for RBAC and change requests. */
public final class GovernanceMappers {

    private GovernanceMappers() {
    }

    // ---------------------------------------------------------------- access

    public static List<Permission> toRestPermissions(
        Collection<com.switchboard.domain.access.Permission> permissions) {
        return permissions.stream()
            .map(permission -> Permission.fromValue(permission.name()))
            .sorted(Comparator.comparing(Permission::getValue))
            .toList();
    }

    public static RoleResponse toRoleResponse(RoleDefinition role) {
        return new RoleResponse(
            role.key(), role.name(), role.builtIn(), toRestPermissions(role.permissions()))
            .description(role.description());
    }

    public static RoleAssignmentResponse toAssignmentResponse(RoleAssignment assignment) {
        return new RoleAssignmentResponse(
            assignment.id(),
            assignment.userId(),
            assignment.userEmail(),
            ScopeType.fromValue(assignment.scopeType().name()),
            assignment.scopeId(),
            assignment.roleKey(),
            assignment.createdAt(),
            assignment.createdBy());
    }

    // ---------------------------------------------------------------- approvals

    public static ApprovalSettingsResponse toApprovalSettingsResponse(ApprovalSettings settings) {
        return new ApprovalSettingsResponse(
            settings.requireApproval(),
            settings.minApprovals(),
            settings.allowSelfApproval(),
            settings.requireApprovalForKill(),
            settings.allowAutomationBypass());
    }

    public static ChangeRequestResponse toChangeRequestResponse(ChangeRequest request) {
        return new ChangeRequestResponse(
            request.id(),
            request.orgId(),
            request.projectId(),
            request.environmentId(),
            request.environmentKey(),
            request.flagId(),
            request.flagKey(),
            ChangeRequestKind.fromValue(request.kind().name()),
            toRestPayload(request.payload()),
            request.baseVersion(),
            request.minApprovals(),
            request.allowSelfApproval(),
            ChangeRequestStatus.fromValue(request.status().name()),
            request.requestedByUserId(),
            request.requestedBy(),
            request.createdAt(),
            request.effectiveApprovers().size(),
            request.reviews().stream().map(GovernanceMappers::toReviewResponse).toList())
            .comment(request.comment())
            .decidedAt(request.decidedAt())
            .appliedVersion(request.appliedVersion())
            .aiProposalId(request.aiProposalId());
    }

    private static ChangeRequestPayload toRestPayload(
        com.switchboard.domain.changerequest.ChangeRequestPayload payload) {
        ChangeRequestPayload rest = new ChangeRequestPayload()
            .enabled(payload.enabled())
            .active(payload.active())
            .toVersion(payload.toVersion());
        return payload.config() == null ? rest : rest.config(FlagMappers.toRestConfig(payload.config()));
    }

    private static ChangeRequestReviewResponse toReviewResponse(ChangeRequestReview review) {
        return new ChangeRequestReviewResponse(
            review.id(),
            review.reviewerUserId(),
            review.reviewer(),
            ReviewDecision.fromValue(review.decision().name()),
            review.createdAt())
            .comment(review.comment())
            .updatedAt(review.updatedAt());
    }
}
