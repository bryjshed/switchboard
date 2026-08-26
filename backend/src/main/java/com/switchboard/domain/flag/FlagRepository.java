package com.switchboard.domain.flag;

import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public interface FlagRepository {

    Mono<Flag> insertFlag(Flag flag);

    /** Inserts the head row; updated_at defaults to now(). */
    Mono<Void> insertHeadConfig(FlagEnvConfig config);

    Mono<Void> insertVersionSnapshot(FlagEnvConfigVersion snapshot);

    /** Non-archived flag row by project + key. */
    Mono<Flag> findByProjectAndKey(UUID projectId, String key);

    /** Non-archived flag with all env head configs, one joined query. */
    Mono<FlagDetail> findDetail(UUID projectId, String key);

    /**
     * Non-archived flags with per-env summaries in one joined query. Keyset-paged by
     * flag key ascending: {@code afterKey} null means from the start.
     */
    Flux<FlagListItem> list(UUID projectId, String query, String tag, String afterKey, int limit);

    /** Rewrites name, description, tags, and variations. */
    Mono<Flag> updateFlag(Flag flag);

    /** Marks archived; emits the number of rows updated (0 = unknown/already archived). */
    Mono<Long> archive(UUID projectId, String key);

    /** SELECT ... FOR UPDATE on the head row; the surrounding transaction holds the lock. */
    Mono<FlagEnvConfig> lockHead(UUID flagId, UUID environmentId);

    /** Rewrites the head row (enabled, kill switch, config, version, updated_by; updated_at = now()). */
    Mono<Void> updateHead(FlagEnvConfig config);

    Mono<FlagEnvConfigVersion> findVersion(UUID flagId, UUID environmentId, int versionNumber);

    /** Versions newest-first; {@code beforeVersion} null means from the head. */
    Flux<FlagEnvConfigVersion> listVersions(UUID flagId, UUID environmentId, Integer beforeVersion, int limit);

    /** Increments environments.state_version and emits the new value. */
    Mono<Long> bumpStateVersion(UUID environmentId);

    /** All non-archived flags of the environment's project with their head configs. */
    Flux<FlagAndConfig> findAllForEnvironment(UUID environmentId);

    /** One non-archived flag's head in an environment, with env key + state version. */
    Mono<FlagHead> findHead(UUID environmentId, String flagKey);

    /** Head configs of every non-archived flag in the project (segment reference checks). */
    Flux<TargetingConfig> findHeadConfigsByProject(UUID projectId);

    /**
     * Every non-archived flag in the project, with its variations.
     *
     * <p>Exists for backfilling a newly created environment. Deliberately unpaginated: a
     * partial backfill would leave some flags configured in the new environment and others
     * silently evaluating to the caller's default, which is worse than either extreme.
     */
    Flux<Flag> findAllByProject(UUID projectId);
}
