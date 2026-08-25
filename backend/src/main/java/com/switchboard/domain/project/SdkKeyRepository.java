package com.switchboard.domain.project;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface SdkKeyRepository {

    Mono<SdkKey> create(
        UUID environmentId, SdkKeyKind kind, String keyPrefix, String keyHash,
        String label, String createdBy);

    Flux<SdkKey> findByEnvironment(UUID environmentId);

    Mono<SdkKey> findById(UUID keyId);

    /**
     * The stored hash, which is the cache key for this key's resolved principal. Deliberately not
     * on {@link SdkKey}: the record is returned to callers and to the API, and a credential digest
     * has no business travelling that far.
     */
    Mono<String> findHashById(UUID keyId);

    Mono<SdkKey> revoke(UUID keyId);
}
