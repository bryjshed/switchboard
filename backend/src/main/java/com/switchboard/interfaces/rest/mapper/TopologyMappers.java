package com.switchboard.interfaces.rest.mapper;

import com.switchboard.application.project.CreatedSdkKey;
import com.switchboard.domain.org.OrgMemberView;
import com.switchboard.domain.org.OrgWithRole;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.project.ProjectWithEnvironments;
import com.switchboard.domain.project.SdkKey;
import com.switchboard.domain.project.SdkKeyKind;
import com.switchboard.interfaces.rest.model.EnvironmentResponse;
import com.switchboard.interfaces.rest.model.OrgMemberResponse;
import com.switchboard.interfaces.rest.model.OrgResponse;
import com.switchboard.interfaces.rest.model.OrgRole;
import com.switchboard.interfaces.rest.model.ProjectResponse;
import com.switchboard.interfaces.rest.model.SdkKeyCreatedResponse;
import com.switchboard.interfaces.rest.model.SdkKeyResponse;

public final class TopologyMappers {

    private TopologyMappers() {
    }

    public static OrgResponse toOrgResponse(OrgWithRole org) {
        return new OrgResponse(org.id(), org.name(), org.slug(), OrgRole.fromValue(org.role()), org.createdAt());
    }

    public static OrgMemberResponse toMemberResponse(OrgMemberView member) {
        return new OrgMemberResponse(
            member.userId(), member.email(), OrgRole.fromValue(member.role()), member.joinedAt())
            .displayName(member.displayName());
    }

    public static ProjectResponse toProjectResponse(ProjectWithEnvironments project) {
        return new ProjectResponse(
            project.project().id(),
            project.project().orgId(),
            project.project().key(),
            project.project().name(),
            project.environments().stream().map(TopologyMappers::toEnvironmentResponse).toList());
    }

    public static EnvironmentResponse toEnvironmentResponse(Environment env) {
        return new EnvironmentResponse(env.id(), env.projectId(), env.key(), env.name(), env.stateVersion())
            .approvals(GovernanceMappers.toApprovalSettingsResponse(env.approvals()));
    }

    public static SdkKeyResponse toSdkKeyResponse(SdkKey key) {
        return new SdkKeyResponse(
            key.id(), key.environmentId(), key.keyPrefix(), key.createdAt(), toRestKind(key.kind()))
            .label(key.label())
            .revokedAt(key.revokedAt());
    }

    public static SdkKeyCreatedResponse toSdkKeyCreatedResponse(CreatedSdkKey created) {
        SdkKey stored = created.stored();
        return new SdkKeyCreatedResponse(
            stored.id(), stored.environmentId(), created.fullKey(), stored.keyPrefix(),
            stored.createdAt(), toRestKind(stored.kind()))
            .label(stored.label());
    }

    private static com.switchboard.interfaces.rest.model.SdkKeyKind toRestKind(SdkKeyKind kind) {
        return com.switchboard.interfaces.rest.model.SdkKeyKind.fromValue(kind.name());
    }
}
