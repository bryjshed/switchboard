package com.switchboard.domain.org;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface OrgRepository {

    Mono<Boolean> slugExists(String slug);

    Mono<Org> create(String name, String slug);

    /** Whether any org exists at all on this instance. */
    Mono<Boolean> anyExists();

    /**
     * Serialises org creation for the rest of the current transaction. Only meaningful inside
     * one: it is what stops two first users on a bootstrap-mode instance from both seeing "no
     * org yet" and both creating one.
     */
    Mono<Void> lockCreation();

    Mono<Org> findById(UUID orgId);

    Flux<OrgWithRole> findAllForUser(UUID userId);

    Flux<OrgMemberView> findMembers(UUID orgId);

    Mono<OrgMemberView> addMember(UUID orgId, UUID userId, String role);

    /** Whether any member of the org has this email, case-insensitively. */
    Mono<Boolean> hasMemberWithEmail(UUID orgId, String email);

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
