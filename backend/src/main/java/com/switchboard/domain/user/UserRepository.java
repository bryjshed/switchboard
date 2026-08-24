package com.switchboard.domain.user;

import reactor.core.publisher.Mono;

public interface UserRepository {

    Mono<User> findByFirebaseUid(String firebaseUid);

    Mono<User> findById(java.util.UUID userId);

    /** Finds by email preferring rows NOT provisioned by a dev token. */
    Mono<User> findByEmailPreferringReal(String email);

    Mono<User> create(String firebaseUid, String email, String displayName);

    /** Re-keys a dev-provisioned row to a real firebase uid (login adoption). */
    Mono<User> adoptFirebaseUid(java.util.UUID userId, String firebaseUid);
}
