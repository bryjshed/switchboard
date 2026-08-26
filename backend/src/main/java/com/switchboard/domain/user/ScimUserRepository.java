package com.switchboard.domain.user;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Persistence for SCIM provisioning.
 *
 * <p>Scoped to an org on every call. SCIM's own model has no notion of one, but Switchboard's
 * does, and a provisioning integration that could reach across orgs would be a tenancy hole
 * rather than a convenience - so the org is a parameter and never inferred.
 */
public interface ScimUserRepository {

    Mono<ScimUser> findInOrgById(UUID orgId, UUID userId);

    Mono<ScimUser> findInOrgByEmail(UUID orgId, String email);

    Mono<ScimUser> findInOrgByExternalId(UUID orgId, String externalId);

    /** Members of the org, oldest first, for SCIM's paginated list. */
    Flux<ScimUser> listInOrg(UUID orgId, String emailFilter, int startIndex, int count);

    Mono<Long> countInOrg(UUID orgId, String emailFilter);

    /** Stamps an existing user with the IdP's identifier. */
    Mono<ScimUser> setExternalId(UUID userId, String externalId);

    Mono<ScimUser> updateProfile(UUID userId, String email, String displayName);

    /** Null clears it, which is how a re-enable is expressed. */
    Mono<ScimUser> setDeactivatedAt(UUID userId, java.time.Instant deactivatedAt);
}
