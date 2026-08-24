package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.flag.EnvConfigResult;
import com.switchboard.application.flag.FlagTargetingService;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * The concurrency test the versioned write path exists for.
 *
 * <p>Twenty kill-switch writes are fired at one flag+environment at once. The
 * kill switch ignores expectedVersion by design, so every one of them must
 * succeed - which means the only thing standing between them and a mangled
 * version chain is the {@code SELECT ... FOR UPDATE} on the head row. If that
 * lock did not serialize, two writers would read the same head version and
 * write the same next version: the head would end below 21, the snapshot table
 * would have a gap or a duplicate, and the unique index on
 * (flag_id, environment_id, version_number) would start rejecting writes.
 */
class FlagUpdateRaceIT extends IntegrationTestBase {

    private static final int CONCURRENT_WRITES = 20;
    private static final String ENV_KEY = "production";

    @Autowired
    private FlagTargetingService targeting;

    @Test
    void concurrentKillSwitchWritesSerializeIntoOneGaplessVersionChain() {
        Workspace workspace = createWorkspace("race");
        FlagDetailResponse flag = createBooleanFlag(workspace, "checkout-race");
        UUID envId = workspace.environmentId(ENV_KEY);
        Map<String, Object> scope = Map.of("flagId", flag.getId(), "envId", envId);

        // Flag creation seeds v1 per environment, so N writes must land on version N + 1.
        int versionAtCreation = 1;
        long stateVersionBefore = stateVersion(envId);

        List<Mono<EnvConfigResult>> writes = IntStream.range(0, CONCURRENT_WRITES)
            .mapToObj(i -> targeting.setKillSwitch(
                workspace.projectId(), flag.getKey(), ENV_KEY,
                workspace.ownerId(), workspace.ownerEmail(),
                i % 2 == 0, "race write " + i))
            .toList();

        List<EnvConfigResult> results = Flux.merge(Flux.fromIterable(writes), CONCURRENT_WRITES)
            .collectList()
            .block(Duration.ofMinutes(2));

        // Every writer succeeded and every writer got its own version number.
        assertThat(results).hasSize(CONCURRENT_WRITES);
        assertThat(results.stream().map(result -> result.head().version()).sorted().toList())
            .containsExactlyElementsOf(range(versionAtCreation + 1, versionAtCreation + CONCURRENT_WRITES));

        Integer headVersion = selectOne(
            "SELECT version FROM flag_env_configs WHERE flag_id = :flagId AND environment_id = :envId",
            Integer.class, scope);
        assertThat(headVersion).isEqualTo(versionAtCreation + CONCURRENT_WRITES);

        // Gapless 1..21 with no duplicates: an exact sequence match proves both.
        List<Integer> snapshots = selectColumn("""
                SELECT version_number FROM flag_env_config_versions
                WHERE flag_id = :flagId AND environment_id = :envId
                ORDER BY version_number
                """, Integer.class, scope);
        assertThat(snapshots)
            .containsExactlyElementsOf(range(versionAtCreation, versionAtCreation + CONCURRENT_WRITES));

        Long killSwitchAudits = selectOne("""
                SELECT count(*) FROM audit_entries
                WHERE flag_key = :flagKey AND environment_id = :envId
                  AND action IN ('KILL_SWITCH_ON', 'KILL_SWITCH_OFF')
                """, Long.class, Map.of("flagKey", flag.getKey(), "envId", envId));
        assertThat(killSwitchAudits).isEqualTo(CONCURRENT_WRITES);

        assertThat(stateVersion(envId) - stateVersionBefore).isEqualTo(CONCURRENT_WRITES);
    }

    private static List<Integer> range(int fromInclusive, int toInclusive) {
        return IntStream.rangeClosed(fromInclusive, toInclusive).boxed().toList();
    }
}
