package com.switchboard.application.flag;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.ListCacheInvalidator;
import com.switchboard.application.cache.SwitchboardCache;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagDetail;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.FlagEnvConfigVersion;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.RolloutOrVariation;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.project.Environment;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.infrastructure.notify.FlagChangePublisher;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.util.function.Tuple2;
import reactor.util.function.Tuples;

/** Flag lifecycle: create (with per-env v1 configs), read, list, patch, archive. */
@Service
public class FlagService {

    private final FlagRepository flags;
    private final EnvironmentRepository environments;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final FlagChangePublisher publisher;
    private final ListCacheInvalidator listCaches;
    private final SwitchboardCache<String, FlagPage> pageCache;
    private final TransactionalOperator tx;
    private final ObjectMapper json;

    @SuppressWarnings("checkstyle:ParameterNumber")
    public FlagService(
        FlagRepository flags,
        EnvironmentRepository environments,
        OrgAccessService access,
        AuditWriter audit,
        FlagChangePublisher publisher,
        ListCacheInvalidator listCaches,
        CacheRegistry caches,
        TransactionalOperator tx,
        ObjectMapper json) {
        this.flags = flags;
        this.environments = environments;
        this.access = access;
        this.audit = audit;
        this.publisher = publisher;
        this.listCaches = listCaches;
        this.pageCache = caches.cache(CacheName.FLAG_LIST);
        this.tx = tx;
        this.json = json;
    }

    /**
     * Creates the flag plus one disabled v1 head config and snapshot per environment,
     * all in one transaction. BOOLEAN flags get generated true/false variations
     * (off=false, fallthrough/default=true); STRING flags take the request's
     * variations (at least 2; off=last, fallthrough/default=first).
     */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<FlagDetail> create(
        UUID projectId, UUID userId, String email, String key, String name,
        String description, FlagKind kind, List<VariationInput> requestedVariations, List<String> tags,
        Boolean clientSideAvailable) {

        List<Variation> variations = buildVariations(kind, requestedVariations);
        TargetingConfig initialConfig = initialConfig(kind, variations);
        // Fails closed: a flag is invisible to public keys unless someone says otherwise.
        Flag flag = new Flag(null, projectId, key, name, description, kind, variations, tags, false,
            Boolean.TRUE.equals(clientSideAvailable));

        return access.requireProjectPermission(projectId, userId, Permission.FLAG_WRITE)
            .flatMap(projectAccess -> environments.findByProject(projectId).collectList()
                .flatMap(envs -> flags.insertFlag(flag)
                    .flatMap(saved -> Flux.fromIterable(envs)
                        .concatMap(env -> seedEnvironment(saved, env, initialConfig, email))
                        .collectList()
                        .flatMap(bumped -> audit.insert(
                                projectAccess.orgId(), projectId, null, key, "CREATE", email,
                                null, null, 1, diff(Map.of("kind", kind.name(), "environments", envs.size())))
                            .thenReturn(bumped)))
                    .as(tx::transactional))
                .doOnNext(bumped -> bumped.forEach(
                    envAndVersion -> publisher.publish(envAndVersion.getT1(), "", envAndVersion.getT2())))
                .doOnNext(ignored -> listCaches.flagsChanged()))
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("A flag with that key already exists in this project"))
            .then(Mono.defer(() -> flags.findDetail(projectId, key)));
    }

    private Mono<Tuple2<UUID, Long>> seedEnvironment(
        Flag flag, Environment env, TargetingConfig config, String email) {
        FlagEnvConfig head = new FlagEnvConfig(flag.id(), env.id(), false, false, config, 1, Instant.now(), email);
        FlagEnvConfigVersion snapshot = new FlagEnvConfigVersion(
            flag.id(), env.id(), 1, false, false, config, "flag created", email, null, null, null);
        return flags.insertHeadConfig(head)
            .then(flags.insertVersionSnapshot(snapshot))
            .then(flags.bumpStateVersion(env.id()))
            .map(stateVersion -> Tuples.of(env.id(), stateVersion));
    }

    public Mono<FlagDetail> get(UUID projectId, String key, UUID userId) {
        return access.requireProjectMember(projectId, userId)
            .then(Mono.defer(() -> flags.findDetail(projectId, key)))
            .switchIfEmpty(Mono.error(new NotFoundException("Flag not found")));
    }

    /**
     * A page of the flag list, read through {@link CacheName#FLAG_LIST}.
     *
     * <p>The access check stays OUTSIDE the cached load and runs on every call. That ordering
     * is the whole safety argument: the cached value is a function of (project, filters,
     * cursor, limit) and of nothing about the caller, so it is safe to share between users -
     * but only because standing is re-checked before it is handed over. Moving the permission
     * check inside the loader would cache the first caller's entitlement along with the data.
     */
    public Mono<FlagPage> list(UUID projectId, UUID userId, String query, String tag, String cursor, int limit) {
        String afterKey = decodeCursor(cursor);
        return access.requireProjectMember(projectId, userId)
            .then(pageCache.get(
                pageKey(projectId, query, tag, afterKey, limit),
                ignored -> Flux.defer(() ->
                        flags.list(projectId, emptyToNull(query), emptyToNull(tag), afterKey, limit))
                    .collectList()
                    .map(items -> new FlagPage(
                        items,
                        items.size() == limit ? encodeCursor(items.get(items.size() - 1).key()) : null))));
    }

    /**
     * Every input that changes the result, and nothing else. Null-safe and unambiguous: the
     * separator cannot appear in a flag key or tag, so ("a", null) and (null, "a") cannot
     * collide into one entry - a collision here would serve one project's flags to another.
     */
    private static String pageKey(UUID projectId, String query, String tag, String afterKey, int limit) {
        return projectId + "\u0000" + nullSafe(query) + "\u0000" + nullSafe(tag)
            + "\u0000" + nullSafe(afterKey) + "\u0000" + limit;
    }

    private static String nullSafe(String value) {
        return value == null || value.isEmpty() ? "-" : value;
    }

    /** PATCH semantics: null name/description and empty tags/addVariations leave the field unchanged. */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<FlagDetail> patch(
        UUID projectId, String key, UUID userId, String email,
        String name, String description, List<String> tags, List<VariationInput> addVariations,
        Boolean clientSideAvailable) {

        return access.requireProjectPermission(projectId, userId, Permission.FLAG_WRITE)
            .flatMap(projectAccess -> flags.findByProjectAndKey(projectId, key)
                .switchIfEmpty(Mono.error(new NotFoundException("Flag not found")))
                .flatMap(flag -> {
                    if (!addVariations.isEmpty() && flag.kind() != FlagKind.STRING) {
                        return Mono.error(new ValidationException(
                            "Variations can only be added to STRING flags"));
                    }
                    List<Variation> variations = new ArrayList<>(flag.variations());
                    addVariations.forEach(input -> variations.add(
                        new Variation(UUID.randomUUID(), input.value(), input.name())));
                    Flag updated = new Flag(
                        flag.id(), flag.projectId(), flag.key(),
                        name != null ? name : flag.name(),
                        description != null ? description : flag.description(),
                        flag.kind(), variations,
                        tags.isEmpty() ? flag.tags() : tags,
                        false,
                        clientSideAvailable != null
                            ? clientSideAvailable
                            : flag.clientSideAvailable());
                    return flags.updateFlag(updated)
                        .flatMap(saved -> audit.insert(
                                projectAccess.orgId(), projectId, null, key, "UPDATE", email,
                                null, null, null, diff(Map.of("flagFieldsChanged", true)))
                            .thenReturn(saved))
                        .as(tx::transactional)
                        // A rename or retag changes the list and bumps no state version, so
                        // it evicts here explicitly - the flag_change NOTIFY never fires for
                        // it, and hanging invalidation off that alone would serve a stale
                        // name until the TTL expired.
                        .doOnNext(ignored -> listCaches.flagsChanged());
                }))
            .then(Mono.defer(() -> flags.findDetail(projectId, key)));
    }

    public Mono<Void> archive(UUID projectId, String key, UUID userId, String email) {
        return access.requireProjectPermission(projectId, userId, Permission.FLAG_WRITE)
            .flatMap(projectAccess -> flags.archive(projectId, key)
                .flatMap(rows -> rows == 0
                    ? Mono.error(new NotFoundException("Flag not found"))
                    : environments.findByProject(projectId).collectList())
                .flatMap(envs -> Flux.fromIterable(envs)
                    .concatMap(env -> flags.bumpStateVersion(env.id())
                        .map(stateVersion -> Tuples.of(env.id(), stateVersion)))
                    .collectList())
                .flatMap(bumped -> audit.insert(
                        projectAccess.orgId(), projectId, null, key, "ARCHIVE", email,
                        null, null, null, null)
                    .thenReturn(bumped))
                .as(tx::transactional)
                .doOnNext(bumped -> bumped.forEach(
                    envAndVersion -> publisher.publish(envAndVersion.getT1(), "", envAndVersion.getT2())))
                .doOnNext(ignored -> listCaches.flagsChanged()))
            .then();
    }

    private static List<Variation> buildVariations(FlagKind kind, List<VariationInput> requested) {
        if (kind == FlagKind.BOOLEAN) {
            return List.of(
                new Variation(UUID.randomUUID(), "true", "True"),
                new Variation(UUID.randomUUID(), "false", "False"));
        }
        if (requested == null || requested.size() < 2) {
            return List.of();
        }
        return requested.stream()
            .map(input -> new Variation(UUID.randomUUID(), input.value(), input.name()))
            .toList();
    }

    /**
     * Delegates to {@link TargetingConfig#initialFor}, which creating an ENVIRONMENT also uses
     * to backfill existing flags. The two must agree, so there is one implementation; the
     * validation stays here because "fewer than two variations" is a user error on this path
     * and an impossibility on the other.
     */
    private static TargetingConfig initialConfig(FlagKind kind, List<Variation> variations) {
        TargetingConfig config = TargetingConfig.initialFor(variations);
        if (config == null) {
            throw new ValidationException("STRING flags require at least 2 variations");
        }
        return config;
    }

    private String diff(Map<String, Object> fields) {
        try {
            return json.writeValueAsString(fields);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    static String encodeCursor(String key) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(key.getBytes(StandardCharsets.UTF_8));
    }

    static String decodeCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        try {
            return new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            throw new ValidationException("Malformed cursor");
        }
    }
}
