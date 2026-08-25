package com.switchboard.domain.token;

import java.time.Instant;
import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Persistence for personal_access_tokens. */
public interface PersonalAccessTokenRepository {

    Mono<PersonalAccessToken> create(
        UUID userId, String name, String tokenPrefix, String tokenHash, Instant expiresAt);

    /** Every token this person owns, revoked ones included - a revocation should be visible. */
    Flux<PersonalAccessToken> findByUser(UUID userId);

    Mono<PersonalAccessToken> findById(UUID tokenId);

    /**
     * Resolves a token hash to the owning user, if the token is usable.
     *
     * <p>Returns the user id rather than the token so the auth path does not have to make a second
     * query, and so nothing that could be logged carries the token's identity around.
     */
    Mono<UUID> findUsableUserIdByHash(String tokenHash, Instant now);

    Mono<PersonalAccessToken> revoke(UUID tokenId);

    /**
     * Advisory, and deliberately fire-and-forget at the call site: a write on every authenticated
     * request would undo the point of caching the lookup.
     */
    Mono<Void> touchLastUsed(String tokenHash, Instant now);
}
