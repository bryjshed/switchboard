package com.switchboard.domain.segment;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface SegmentRepository {

    Mono<Segment> insert(Segment segment);

    /** Rewrites name, includedKeys, excludedKeys, rules by (projectId, key); updated_at = now(). */
    Mono<Segment> update(Segment segment);

    /** Emits the number of rows deleted (0 = unknown key). */
    Mono<Long> delete(UUID projectId, String key);

    Mono<Segment> findByKey(UUID projectId, String key);

    Flux<Segment> findByProject(UUID projectId);
}
