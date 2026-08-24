package com.switchboard.domain.access;

import java.util.UUID;

/** Where an authorization question is being asked: a scope type plus that scope's id. */
public record AccessScope(ScopeType type, UUID id) {

    public static AccessScope org(UUID orgId) {
        return new AccessScope(ScopeType.ORG, orgId);
    }

    public static AccessScope project(UUID projectId) {
        return new AccessScope(ScopeType.PROJECT, projectId);
    }

    public static AccessScope environment(UUID environmentId) {
        return new AccessScope(ScopeType.ENVIRONMENT, environmentId);
    }
}
