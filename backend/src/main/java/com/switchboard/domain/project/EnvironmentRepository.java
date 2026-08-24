package com.switchboard.domain.project;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface EnvironmentRepository {

    Mono<Environment> create(UUID projectId, String key, String name);

    Mono<Environment> findById(UUID environmentId);

    /** Rewrites the environment's approval policy; emits the updated row. */
    Mono<Environment> updateApprovalSettings(UUID environmentId, ApprovalSettings settings);

    Flux<Environment> findByProject(UUID projectId);

    /** One environment by its project-unique key; empty when there is none. */
    Mono<Environment> findByProjectAndKey(UUID projectId, String key);

    /** All environments of every project in the org (avoids per-project queries when listing). */
    Flux<Environment> findByOrg(UUID orgId);
}
