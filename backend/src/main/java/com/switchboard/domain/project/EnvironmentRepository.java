package com.switchboard.domain.project;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface EnvironmentRepository {

    Mono<Environment> create(UUID projectId, String key, String name);

    Mono<Environment> findById(UUID environmentId);

    /** Changes the display name only - the key is immutable, see ProjectService. */
    Mono<Environment> rename(UUID environmentId, String name);

    /** Sets or clears archived_at; emits the updated row. */
    Mono<Environment> setArchived(UUID environmentId, boolean archived);

    /** How many environments in the project are NOT archived. */
    Mono<Long> countActive(UUID projectId);

    /** Rewrites the environment's approval policy; emits the updated row. */
    Mono<Environment> updateApprovalSettings(UUID environmentId, ApprovalSettings settings);

    Flux<Environment> findByProject(UUID projectId);

    /** One environment by its project-unique key; empty when there is none. */
    Mono<Environment> findByProjectAndKey(UUID projectId, String key);

    /** All environments of every project in the org (avoids per-project queries when listing). */
    Flux<Environment> findByOrg(UUID orgId);
}
