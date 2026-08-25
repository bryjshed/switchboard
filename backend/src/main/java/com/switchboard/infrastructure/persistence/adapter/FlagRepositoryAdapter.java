package com.switchboard.infrastructure.persistence.adapter;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagAndConfig;
import com.switchboard.domain.flag.FlagDetail;
import com.switchboard.domain.flag.FlagEnvConfig;
import com.switchboard.domain.flag.FlagEnvConfigVersion;
import com.switchboard.domain.flag.FlagEnvSummaryView;
import com.switchboard.domain.flag.FlagHead;
import com.switchboard.domain.flag.FlagKind;
import com.switchboard.domain.flag.FlagListItem;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.NamedEnvConfig;
import com.switchboard.domain.flag.TargetingConfig;
import com.switchboard.domain.flag.Variation;
import com.switchboard.domain.flag.WeightedVariation;
import io.r2dbc.spi.Readable;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Flags + per-env head configs + version snapshots. JSONB columns (variations,
 * config) are written via CAST(:x AS jsonb) and read back as String through the
 * injected ObjectMapper.
 */
@Repository
public class FlagRepositoryAdapter implements FlagRepository {

    private static final TypeReference<List<Variation>> VARIATIONS_TYPE = new TypeReference<>() {
    };

    private final DatabaseClient db;
    private final ObjectMapper json;

    public FlagRepositoryAdapter(DatabaseClient db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    // ---------------------------------------------------------------- writes

    @Override
    public Mono<Flag> insertFlag(Flag flag) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                INSERT INTO flags
                    (project_id, key, name, description, kind, variations, tags,
                     client_side_available)
                VALUES (:projectId, :key, :name, :description, :kind, CAST(:variations AS jsonb),
                        :tags, :clientSideAvailable)
                RETURNING *
                """)
            .bind("clientSideAvailable", flag.clientSideAvailable())
            .bind("projectId", flag.projectId())
            .bind("key", flag.key())
            .bind("name", flag.name())
            .bind("kind", flag.kind().name())
            .bind("variations", write(flag.variations()))
            .bind("tags", flag.tags().toArray(String[]::new));
        return bindNullable(spec, "description", flag.description(), String.class)
            .map(this::mapFlag)
            .one();
    }

    @Override
    public Mono<Void> insertHeadConfig(FlagEnvConfig config) {
        return db.sql("""
                INSERT INTO flag_env_configs
                    (flag_id, environment_id, enabled, kill_switch_active, config, version, updated_by)
                VALUES (:flagId, :envId, :enabled, :killSwitch, CAST(:config AS jsonb), :version, :updatedBy)
                """)
            .bind("flagId", config.flagId())
            .bind("envId", config.environmentId())
            .bind("enabled", config.enabled())
            .bind("killSwitch", config.killSwitchActive())
            .bind("config", write(config.config()))
            .bind("version", config.version())
            .bind("updatedBy", config.updatedBy())
            .then();
    }

    @Override
    public Mono<Void> insertVersionSnapshot(FlagEnvConfigVersion snapshot) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                INSERT INTO flag_env_config_versions
                    (flag_id, environment_id, version_number, enabled, kill_switch_active,
                     config, version_note, created_by, created_from_proposal_id,
                     created_from_change_request_id)
                VALUES (:flagId, :envId, :versionNumber, :enabled, :killSwitch,
                        CAST(:config AS jsonb), :versionNote, :createdBy, :proposalId,
                        :changeRequestId)
                """)
            .bind("flagId", snapshot.flagId())
            .bind("envId", snapshot.environmentId())
            .bind("versionNumber", snapshot.versionNumber())
            .bind("enabled", snapshot.enabled())
            .bind("killSwitch", snapshot.killSwitchActive())
            .bind("config", write(snapshot.config()))
            .bind("createdBy", snapshot.createdBy());
        spec = bindNullable(spec, "versionNote", snapshot.versionNote(), String.class);
        spec = bindNullable(spec, "proposalId", snapshot.createdFromProposalId(), UUID.class);
        spec = bindNullable(spec, "changeRequestId", snapshot.createdFromChangeRequestId(), UUID.class);
        return spec.then();
    }

    @Override
    public Mono<Flag> updateFlag(Flag flag) {
        DatabaseClient.GenericExecuteSpec spec = db.sql("""
                UPDATE flags
                SET name = :name, description = :description, tags = :tags,
                    variations = CAST(:variations AS jsonb),
                    client_side_available = :clientSideAvailable
                WHERE id = :id
                RETURNING *
                """)
            .bind("clientSideAvailable", flag.clientSideAvailable())
            .bind("id", flag.id())
            .bind("name", flag.name())
            .bind("tags", flag.tags().toArray(String[]::new))
            .bind("variations", write(flag.variations()));
        return bindNullable(spec, "description", flag.description(), String.class)
            .map(this::mapFlag)
            .one();
    }

    @Override
    public Mono<Long> archive(UUID projectId, String key) {
        return db.sql("""
                UPDATE flags SET archived_at = now()
                WHERE project_id = :projectId AND key = :key AND archived_at IS NULL
                """)
            .bind("projectId", projectId)
            .bind("key", key)
            .fetch()
            .rowsUpdated();
    }

    @Override
    public Mono<FlagEnvConfig> lockHead(UUID flagId, UUID environmentId) {
        return db.sql("""
                SELECT * FROM flag_env_configs
                WHERE flag_id = :flagId AND environment_id = :envId
                FOR UPDATE
                """)
            .bind("flagId", flagId)
            .bind("envId", environmentId)
            .map(this::mapHead)
            .one();
    }

    @Override
    public Mono<Void> updateHead(FlagEnvConfig config) {
        return db.sql("""
                UPDATE flag_env_configs
                SET enabled = :enabled, kill_switch_active = :killSwitch,
                    config = CAST(:config AS jsonb), version = :version,
                    updated_at = now(), updated_by = :updatedBy
                WHERE flag_id = :flagId AND environment_id = :envId
                """)
            .bind("flagId", config.flagId())
            .bind("envId", config.environmentId())
            .bind("enabled", config.enabled())
            .bind("killSwitch", config.killSwitchActive())
            .bind("config", write(config.config()))
            .bind("version", config.version())
            .bind("updatedBy", config.updatedBy())
            .then();
    }

    @Override
    public Mono<Long> bumpStateVersion(UUID environmentId) {
        return db.sql("""
                UPDATE environments SET state_version = state_version + 1
                WHERE id = :envId
                RETURNING state_version
                """)
            .bind("envId", environmentId)
            .map(row -> row.get("state_version", Long.class))
            .one();
    }

    // ---------------------------------------------------------------- reads

    @Override
    public Mono<Flag> findByProjectAndKey(UUID projectId, String key) {
        return db.sql("SELECT * FROM flags WHERE project_id = :projectId AND key = :key AND archived_at IS NULL")
            .bind("projectId", projectId)
            .bind("key", key)
            .map(this::mapFlag)
            .one();
    }

    @Override
    public Mono<FlagDetail> findDetail(UUID projectId, String key) {
        return db.sql("""
                SELECT f.id AS f_id, f.project_id, f.key AS f_key, f.name AS f_name, f.description,
                       f.kind, f.variations, f.tags, f.client_side_available,
                       e.key AS env_key, c.flag_id, c.environment_id, c.enabled, c.kill_switch_active,
                       c.config, c.version, c.updated_at, c.updated_by
                FROM flags f
                JOIN flag_env_configs c ON c.flag_id = f.id
                JOIN environments e ON e.id = c.environment_id
                WHERE f.project_id = :projectId AND f.key = :key AND f.archived_at IS NULL
                ORDER BY e.created_at, e.key
                """)
            .bind("projectId", projectId)
            .bind("key", key)
            .map(row -> Map.entry(mapPrefixedFlag(row), new NamedEnvConfig(
                row.get("env_key", String.class), mapHead(row))))
            .all()
            .collectList()
            .flatMap(rows -> rows.isEmpty()
                ? Mono.empty()
                : Mono.just(new FlagDetail(
                    rows.get(0).getKey(),
                    rows.stream().map(Map.Entry::getValue).toList())));
    }

    @Override
    public Flux<FlagListItem> list(UUID projectId, String query, String tag, String afterKey, int limit) {
        StringBuilder inner = new StringBuilder(
            "SELECT key FROM flags WHERE project_id = :projectId AND archived_at IS NULL");
        if (query != null) {
            inner.append(" AND (key ILIKE :query OR name ILIKE :query)");
        }
        if (tag != null) {
            inner.append(" AND :tag = ANY(tags)");
        }
        if (afterKey != null) {
            inner.append(" AND key > :afterKey");
        }
        inner.append(" ORDER BY key LIMIT :limit");

        String sql = """
            SELECT f.id AS f_id, f.key AS f_key, f.name AS f_name, f.kind, f.tags, f.variations,
                   f.client_side_available,
                   e.key AS env_key, c.enabled, c.kill_switch_active, c.config, c.version,
                   c.updated_at, c.updated_by
            FROM flags f
            JOIN flag_env_configs c ON c.flag_id = f.id
            JOIN environments e ON e.id = c.environment_id
            WHERE f.project_id = :projectId AND f.archived_at IS NULL AND f.key IN (%s)
            ORDER BY f.key, e.created_at, e.key
            """.formatted(inner);

        DatabaseClient.GenericExecuteSpec spec = db.sql(sql)
            .bind("projectId", projectId)
            .bind("limit", limit);
        if (query != null) {
            spec = spec.bind("query", "%" + query + "%");
        }
        if (tag != null) {
            spec = spec.bind("tag", tag);
        }
        if (afterKey != null) {
            spec = spec.bind("afterKey", afterKey);
        }
        return spec.map(this::mapListRow)
            .all()
            .collectList()
            .flatMapMany(rows -> Flux.fromIterable(groupListRows(rows)));
    }

    @Override
    public Mono<FlagEnvConfigVersion> findVersion(UUID flagId, UUID environmentId, int versionNumber) {
        return db.sql("""
                SELECT * FROM flag_env_config_versions
                WHERE flag_id = :flagId AND environment_id = :envId AND version_number = :versionNumber
                """)
            .bind("flagId", flagId)
            .bind("envId", environmentId)
            .bind("versionNumber", versionNumber)
            .map(this::mapVersion)
            .one();
    }

    @Override
    public Flux<FlagEnvConfigVersion> listVersions(UUID flagId, UUID environmentId, Integer beforeVersion, int limit) {
        String sql = """
            SELECT * FROM flag_env_config_versions
            WHERE flag_id = :flagId AND environment_id = :envId%s
            ORDER BY version_number DESC LIMIT :limit
            """.formatted(beforeVersion == null ? "" : " AND version_number < :beforeVersion");
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql)
            .bind("flagId", flagId)
            .bind("envId", environmentId)
            .bind("limit", limit);
        if (beforeVersion != null) {
            spec = spec.bind("beforeVersion", beforeVersion);
        }
        return spec.map(this::mapVersion).all();
    }

    @Override
    public Flux<FlagAndConfig> findAllForEnvironment(UUID environmentId) {
        return db.sql("""
                SELECT f.id AS f_id, f.project_id, f.key AS f_key, f.name AS f_name, f.description,
                       f.kind, f.variations, f.tags, f.client_side_available,
                       c.flag_id, c.environment_id, c.enabled, c.kill_switch_active,
                       c.config, c.version, c.updated_at, c.updated_by
                FROM flag_env_configs c
                JOIN flags f ON f.id = c.flag_id
                WHERE c.environment_id = :envId AND f.archived_at IS NULL
                ORDER BY f.key
                """)
            .bind("envId", environmentId)
            .map(row -> new FlagAndConfig(mapPrefixedFlag(row), mapHead(row)))
            .all();
    }

    @Override
    public Mono<FlagHead> findHead(UUID environmentId, String flagKey) {
        return db.sql("""
                SELECT f.id AS f_id, f.project_id, f.key AS f_key, f.name AS f_name, f.description,
                       f.kind, f.variations, f.tags, f.client_side_available,
                       e.key AS env_key, e.state_version,
                       c.flag_id, c.environment_id, c.enabled, c.kill_switch_active,
                       c.config, c.version, c.updated_at, c.updated_by
                FROM flag_env_configs c
                JOIN flags f ON f.id = c.flag_id
                JOIN environments e ON e.id = c.environment_id
                WHERE c.environment_id = :envId AND f.key = :flagKey AND f.archived_at IS NULL
                """)
            .bind("envId", environmentId)
            .bind("flagKey", flagKey)
            .map(row -> new FlagHead(
                mapPrefixedFlag(row),
                mapHead(row),
                row.get("env_key", String.class),
                row.get("state_version", Long.class)))
            .one();
    }

    @Override
    public Flux<TargetingConfig> findHeadConfigsByProject(UUID projectId) {
        return db.sql("""
                SELECT c.config FROM flag_env_configs c
                JOIN flags f ON f.id = c.flag_id
                WHERE f.project_id = :projectId AND f.archived_at IS NULL
                """)
            .bind("projectId", projectId)
            .map(row -> readConfig(row.get("config", String.class)))
            .all();
    }

    // ---------------------------------------------------------------- mapping

    private Flag mapFlag(Readable row) {
        return new Flag(
            row.get("id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("key", String.class),
            row.get("name", String.class),
            row.get("description", String.class),
            FlagKind.valueOf(row.get("kind", String.class)),
            readVariations(row.get("variations", String.class)),
            List.of(row.get("tags", String[].class)),
            false,
            Boolean.TRUE.equals(row.get("client_side_available", Boolean.class)));
    }

    /** Flag columns aliased f_id / f_key / f_name in joined queries. */
    private Flag mapPrefixedFlag(Readable row) {
        return new Flag(
            row.get("f_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("f_key", String.class),
            row.get("f_name", String.class),
            row.get("description", String.class),
            FlagKind.valueOf(row.get("kind", String.class)),
            readVariations(row.get("variations", String.class)),
            List.of(row.get("tags", String[].class)),
            false,
            Boolean.TRUE.equals(row.get("client_side_available", Boolean.class)));
    }

    private FlagEnvConfig mapHead(Readable row) {
        return new FlagEnvConfig(
            row.get("flag_id", UUID.class),
            row.get("environment_id", UUID.class),
            Boolean.TRUE.equals(row.get("enabled", Boolean.class)),
            Boolean.TRUE.equals(row.get("kill_switch_active", Boolean.class)),
            readConfig(row.get("config", String.class)),
            row.get("version", Integer.class),
            row.get("updated_at", Instant.class),
            row.get("updated_by", String.class));
    }

    private FlagEnvConfigVersion mapVersion(Readable row) {
        return new FlagEnvConfigVersion(
            row.get("flag_id", UUID.class),
            row.get("environment_id", UUID.class),
            row.get("version_number", Integer.class),
            Boolean.TRUE.equals(row.get("enabled", Boolean.class)),
            Boolean.TRUE.equals(row.get("kill_switch_active", Boolean.class)),
            readConfig(row.get("config", String.class)),
            row.get("version_note", String.class),
            row.get("created_by", String.class),
            row.get("created_from_proposal_id", UUID.class),
            row.get("created_from_change_request_id", UUID.class),
            row.get("created_at", Instant.class));
    }

    private record ListRow(UUID id, String key, String name, FlagKind kind, List<String> tags,
                           FlagEnvSummaryView env) {
    }

    private ListRow mapListRow(Readable row) {
        TargetingConfig config = readConfig(row.get("config", String.class));
        return new ListRow(
            row.get("f_id", UUID.class),
            row.get("f_key", String.class),
            row.get("f_name", String.class),
            FlagKind.valueOf(row.get("kind", String.class)),
            List.of(row.get("tags", String[].class)),
            new FlagEnvSummaryView(
                row.get("env_key", String.class),
                Boolean.TRUE.equals(row.get("enabled", Boolean.class)),
                Boolean.TRUE.equals(row.get("kill_switch_active", Boolean.class)),
                rolloutPercentage(config),
                row.get("version", Integer.class),
                row.get("updated_at", Instant.class),
                row.get("updated_by", String.class)));
    }

    private static List<FlagListItem> groupListRows(List<ListRow> rows) {
        Map<String, List<ListRow>> byKey = new LinkedHashMap<>();
        for (ListRow row : rows) {
            byKey.computeIfAbsent(row.key(), k -> new ArrayList<>()).add(row);
        }
        return byKey.values().stream()
            .map(group -> new FlagListItem(
                group.get(0).id(), group.get(0).key(), group.get(0).name(), group.get(0).kind(),
                group.get(0).tags(), group.stream().map(ListRow::env).toList()))
            .toList();
    }

    /** Fallthrough-rollout weight of the default variation, or null for a fixed fallthrough. */
    private static Integer rolloutPercentage(TargetingConfig config) {
        if (!config.fallthrough().hasRollout()) {
            return null;
        }
        return config.fallthrough().rollout().stream()
            .filter(w -> w.variationId().equals(config.defaultVariationId()))
            .findFirst()
            .map(WeightedVariation::weight)
            .orElse(null);
    }

    private static DatabaseClient.GenericExecuteSpec bindNullable(
        DatabaseClient.GenericExecuteSpec spec, String name, Object value, Class<?> type) {
        return value == null ? spec.bindNull(name, type) : spec.bind(name, value);
    }

    private String write(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize flag JSON", e);
        }
    }

    private List<Variation> readVariations(String raw) {
        try {
            return json.readValue(raw, VARIATIONS_TYPE);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to deserialize flag variations", e);
        }
    }

    private TargetingConfig readConfig(String raw) {
        try {
            return json.readValue(raw, TargetingConfig.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to deserialize targeting config", e);
        }
    }
}
