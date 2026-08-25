package com.switchboard.domain.user;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface UserRepository {

    /** The user carrying this exact provider identity, if it has ever been linked. */
    Mono<User> findByIssuerAndSubject(String issuer, String subject);

    Mono<User> findById(UUID userId);

    /**
     * Finds by email, preferring a user who already holds a real (non dev-provisioned) identity.
     * The ordering matters because a dev-provisioned row is a placeholder for a person who has
     * not signed in yet, and a real row is that person.
     */
    Mono<User> findByEmailPreferringReal(String email);

    Mono<User> create(String email, String displayName);

    /** Links a provider identity to an existing user. Fails if that identity is already linked. */
    Mono<UserIdentity> linkIdentity(UUID userId, String issuer, String subject);

    Flux<UserIdentity> identitiesOf(UUID userId);
}
