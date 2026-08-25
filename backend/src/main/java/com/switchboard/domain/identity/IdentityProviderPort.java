package com.switchboard.domain.identity;

import reactor.core.publisher.Mono;

/**
 * Turns a raw credential into a {@link VerifiedIdentity}, or fails.
 *
 * <p>The port is deliberately this small. Everything that differs between one identity provider
 * and the next - discovery documents, key endpoints, claim names, local-development quirks - lives
 * behind this method in {@code infrastructure/identity}, and none of it reaches the domain. The
 * domain does not know the name of a single vendor, which is the property that makes swapping one
 * a configuration change.
 *
 * <p>Implementations must signal an error (rather than complete empty) when the token is invalid
 * for them, so a caller can tell "rejected" from "not mine".
 */
public interface IdentityProviderPort {

    Mono<VerifiedIdentity> verify(String rawToken);
}
