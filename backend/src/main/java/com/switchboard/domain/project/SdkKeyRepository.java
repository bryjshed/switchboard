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

    Mono<SdkKey> revoke(UUID keyId);
}
