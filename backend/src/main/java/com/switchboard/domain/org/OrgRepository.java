package com.switchboard.domain.org;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface OrgRepository {

    Mono<Boolean> slugExists(String slug);

    Mono<Org> create(String name, String slug);

    Mono<Org> findById(UUID orgId);

    Flux<OrgWithRole> findAllForUser(UUID userId);

    Flux<OrgMemberView> findMembers(UUID orgId);

    Mono<OrgMemberView> addMember(UUID orgId, UUID userId, String role);

    /** Empty when the membership does not exist. */
    Mono<String> findMemberRole(UUID orgId, UUID userId);

    Mono<Long> countByRole(UUID orgId, String role);

    Mono<Long> removeMember(UUID orgId, UUID userId);

    /**
     * Any OWNER of the org. Background jobs have no caller of their own, so an
     * auto-applied proposal borrows an owner's identity for the access checks
     * while the audit trail records the job as the actor.
     */
    Mono<UUID> findAnyOwnerId(UUID orgId);
}
