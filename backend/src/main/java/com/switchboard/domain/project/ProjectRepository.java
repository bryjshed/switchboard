package com.switchboard.domain.project;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface ProjectRepository {

    Mono<Project> create(UUID orgId, String key, String name);

    Mono<Project> findById(UUID projectId);

    Flux<Project> findByOrg(UUID orgId);

    Mono<Project> updateName(UUID projectId, String name);
}
