package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;

/**
 * The dashboard list caches: effective on repeated reads, and NEVER stale after a write.
 *
 * <p>The second half is the one that matters. A cache that is merely fast is easy; the reason
 * this one is safe to have at all is that every write which could change a list clears it,
 * so the TTL is a backstop rather than a staleness budget. Each test here writes something
 * and immediately asserts the very next read reflects it - if invalidation were missing,
 * these would pass for five minutes and then start failing, which is exactly the kind of bug
 * a TTL-only design hides.
 */
class ListCacheIT extends IntegrationTestBase {

    @Autowired
    private CacheRegistry caches;

    private long flagListSize() {
        return caches.cache(CacheName.FLAG_LIST).estimatedSize();
    }

    private Map<String, Object> listBody(Workspace workspace) {
        return http.get().uri("/api/projects/{p}/flags?limit=50", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {})
            .returnResult().getResponseBody();
    }

    private java.util.List<String> listFlagKeys(Workspace workspace) {
        return ((java.util.List<?>) listBody(workspace).get("items")).stream()
            .map(item -> String.valueOf(((Map<?, ?>) item).get("key")))
            .toList();
    }

    @Test
    void repeatedListReadsAreServedFromTheCache() {
        Workspace workspace = createWorkspace("cache-hit");
        createBooleanFlag(workspace, "cache-a");

        listFlagKeys(workspace);
        long afterFirst = flagListSize();
        for (int i = 0; i < 10; i++) {
            listFlagKeys(workspace);
        }
        assertThat(flagListSize())
            .as("ten more identical reads must not add entries - they are hits")
            .isEqualTo(afterFirst);
    }

    @Test
    void creatingAFlagIsVisibleImmediately() {
        Workspace workspace = createWorkspace("cache-create");
        createBooleanFlag(workspace, "cache-first");
        assertThat(listFlagKeys(workspace)).containsExactly("cache-first");

        createBooleanFlag(workspace, "cache-second");
        assertThat(listFlagKeys(workspace))
            .as("a newly created flag must appear on the very next read")
            .contains("cache-second");
    }

    @Test
    void archivingAFlagIsVisibleImmediately() {
        Workspace workspace = createWorkspace("cache-archive");
        createBooleanFlag(workspace, "cache-doomed");
        createBooleanFlag(workspace, "cache-kept");
        assertThat(listFlagKeys(workspace)).contains("cache-doomed");

        http.delete().uri("/api/projects/{p}/flags/{k}", workspace.projectId(), "cache-doomed")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isNoContent();

        assertThat(listFlagKeys(workspace))
            .as("an archived flag must disappear on the very next read")
            .doesNotContain("cache-doomed")
            .contains("cache-kept");
    }

    @Test
    void aRenameIsVisibleImmediatelyEvenThoughItBumpsNoStateVersion() {
        // The regression this exists for. A PATCH of name/tags writes an audit row and bumps
        // NO state version, so it fires no flag_change NOTIFY. A design that hung list
        // invalidation off that notification alone would serve the old name until the TTL
        // expired - correct-looking in every test that did not wait five minutes.
        Workspace workspace = createWorkspace("cache-rename");
        FlagDetailResponse flag = createBooleanFlag(workspace, "cache-renamed");

        String before = flagName(workspace, "cache-renamed");
        assertThat(before).isEqualTo("cache-renamed");

        http.patch().uri("/api/projects/{p}/flags/{k}", workspace.projectId(), "cache-renamed")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("name", "Renamed In Place"))
            .exchange()
            .expectStatus().isOk();

        assertThat(flagName(workspace, "cache-renamed"))
            .as("a rename must be visible on the very next list read")
            .isEqualTo("Renamed In Place");
        assertThat(flag.getKey()).isEqualTo("cache-renamed");
    }

    @Test
    void aTargetingWriteIsVisibleImmediately() {
        // The flag list carries each environment's version, so a targeting write changes the
        // list even though no flag was added or removed. Reading the list BEFORE the write is
        // what makes this meaningful: it populates the entry that must then be invalidated.
        Workspace workspace = createWorkspace("cache-targeting");
        FlagDetailResponse flag = createBooleanFlag(workspace, "cache-target");
        UUID envId = workspace.environmentId("production");

        assertThat(listedProductionVersion(workspace, "cache-target")).isEqualTo(1);

        http.put().uri("/api/projects/{p}/flags/{k}/environments/{e}",
                workspace.projectId(), "cache-target", "production")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(serveRequest(flag, "production", "false", headVersion(flag.getId(), envId)))
            .exchange()
            .expectStatus().isOk();

        assertThat(listedProductionVersion(workspace, "cache-target"))
            .as("the new version must appear on the very next list read")
            .isEqualTo(2);
    }

    /** The production env config version this flag reports IN THE LIST payload. */
    private int listedProductionVersion(Workspace workspace, String key) {
        Map<String, Object> body = listBody(workspace);
        for (Object item : (java.util.List<?>) body.get("items")) {
            Map<?, ?> flag = (Map<?, ?>) item;
            if (!key.equals(flag.get("key"))) {
                continue;
            }
            for (Object env : (java.util.List<?>) flag.get("environments")) {
                Map<?, ?> envConfig = (Map<?, ?>) env;
                if ("production".equals(envConfig.get("envKey"))) {
                    return ((Number) envConfig.get("version")).intValue();
                }
            }
        }
        throw new AssertionError("no production config listed for " + key);
    }

    @Test
    void oneProjectsWritesDoNotLeakAnotherProjectsFlagsIntoItsList() {
        // The key includes the project id, so two projects cannot share an entry. A collision
        // here would be a cross-tenant data leak rather than a performance nit.
        Workspace a = createWorkspace("cache-iso-a");
        Workspace b = createWorkspace("cache-iso-b");
        createBooleanFlag(a, "only-in-a");
        createBooleanFlag(b, "only-in-b");

        assertThat(listFlagKeys(a)).containsExactly("only-in-a");
        assertThat(listFlagKeys(b)).containsExactly("only-in-b");
    }

    @Test
    void differentFiltersDoNotShareAnEntry() {
        Workspace workspace = createWorkspace("cache-filters");
        createBooleanFlag(workspace, "alpha-one");
        createBooleanFlag(workspace, "beta-two");

        var filtered = http.get().uri("/api/projects/{p}/flags?query=alpha&limit=50", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.items.length()").isEqualTo(1)
            .jsonPath("$.items[0].key").isEqualTo("alpha-one");
        assertThat(filtered).isNotNull();

        // The unfiltered read must not be answered from the filtered entry.
        assertThat(listFlagKeys(workspace)).containsExactlyInAnyOrder("alpha-one", "beta-two");
    }

    private String flagName(Workspace workspace, String key) {
        return ((java.util.List<?>) listBody(workspace).get("items")).stream()
            .map(item -> (Map<?, ?>) item)
            .filter(item -> key.equals(item.get("key")))
            .map(item -> String.valueOf(item.get("name")))
            .findFirst().orElseThrow(() -> new AssertionError("no flag " + key + " listed"));
    }
}
