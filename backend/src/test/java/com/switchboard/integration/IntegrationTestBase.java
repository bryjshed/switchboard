package com.switchboard.integration;

import com.google.firebase.auth.FirebaseAuth;
import com.switchboard.interfaces.rest.model.ApprovalSettingsResponse;
import com.switchboard.interfaces.rest.model.ApprovalSettingsUpdateRequest;
import com.switchboard.interfaces.rest.model.EnvironmentResponse;
import com.switchboard.interfaces.rest.model.FlagCreateRequest;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigResponse;
import com.switchboard.interfaces.rest.model.FlagEnvConfigUpdateRequest;
import com.switchboard.interfaces.rest.model.FlagKind;
import com.switchboard.interfaces.rest.model.FlagTargetingConfig;
import com.switchboard.interfaces.rest.model.OrgCreateRequest;
import com.switchboard.interfaces.rest.model.OrgMemberAddRequest;
import com.switchboard.interfaces.rest.model.OrgResponse;
import com.switchboard.interfaces.rest.model.OrgRole;
import com.switchboard.interfaces.rest.model.ProjectCreateRequest;
import com.switchboard.interfaces.rest.model.ProjectResponse;
import com.switchboard.interfaces.rest.model.RoleAssignmentCreateRequest;
import com.switchboard.interfaces.rest.model.RoleAssignmentResponse;
import com.switchboard.interfaces.rest.model.RolloutOrVariation;
import com.switchboard.interfaces.rest.model.ScopeType;
import com.switchboard.interfaces.rest.model.SdkKeyCreateRequest;
import com.switchboard.interfaces.rest.model.SdkKeyCreatedResponse;
import com.switchboard.interfaces.rest.model.UserResponse;
import com.switchboard.interfaces.rest.model.VariationCreate;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * The whole integration suite hangs off this class.
 *
 * <p>ONE Postgres container per JVM, started from a static initializer and left
 * to Ryuk to reap. Each test CLASS gets its own freshly created database on that
 * container, registered through {@link DynamicPropertySource} so Flyway replays
 * V1__baseline.sql into an empty schema and nothing bleeds between classes.
 *
 * <p>{@code @DirtiesContext} (default AFTER_CLASS) is what makes that work: it
 * evicts the context from the test-context cache when a class finishes, so the
 * next class builds a new context and the dynamic-property method runs again
 * against a new database. Without it every subclass would share one cached
 * context - the customizer's identity is the set of annotated methods, which is
 * the same inherited method for all of them - and therefore one database.
 *
 * <p>Authentication uses the local dev-token path ({@code Bearer dev:<email>}),
 * so tests exercise the real security filter chain without a Firebase project.
 * {@link FirebaseAuth} is mocked because the production bean would otherwise
 * reach for application-default credentials at startup; nothing in this suite
 * takes the Firebase branch of the authentication manager.
 */
@Tag("integration")
@DirtiesContext
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
        "switchboard.security.dev-auth-enabled=true",
        "switchboard.jobs.token=" + IntegrationTestBase.JOB_TOKEN,
        // The hourly in-process scan must never race a test's own scan.
        "switchboard.jobs.scheduled-enabled=false",
        // Force the keyless assistant even when the developer exports ANTHROPIC_API_KEY.
        "switchboard.ai.anthropic-api-key=",
        // The race tests hold one connection per in-flight write.
        "spring.r2dbc.pool.max-size=25"
    })
public abstract class IntegrationTestBase {

    protected static final String JOB_TOKEN = "switchboard-integration-job-token";
    protected static final Duration DB_TIMEOUT = Duration.ofSeconds(60);

    private static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18")
        .withDatabaseName("switchboard")
        .withUsername("postgres")
        .withPassword("postgres");

    private static final AtomicInteger DATABASE_SEQUENCE = new AtomicInteger();

    static {
        POSTGRES.start();
    }

    /** Never exercised: the dev-token path resolves users without Firebase. */
    @MockitoBean
    private FirebaseAuth firebaseAuth;

    @Value("${local.server.port}")
    private int port;

    @Autowired
    protected DatabaseClient db;

    /** WebTestClient against the running server, with a timeout that survives a cold JIT. */
    protected WebTestClient http;

    @BeforeEach
    void bindHttpClient() {
        http = WebTestClient.bindToServer()
            .baseUrl("http://localhost:" + port)
            .responseTimeout(Duration.ofSeconds(60))
            .build();
    }

    @DynamicPropertySource
    static void freshDatabasePerTestClass(DynamicPropertyRegistry registry) {
        String database = createDatabase();
        String hostAndPort =
            POSTGRES.getHost() + ":" + POSTGRES.getMappedPort(PostgreSQLContainer.POSTGRESQL_PORT);
        registry.add("spring.r2dbc.url", () -> "r2dbc:postgresql://" + hostAndPort + "/" + database);
        registry.add("spring.r2dbc.username", POSTGRES::getUsername);
        registry.add("spring.r2dbc.password", POSTGRES::getPassword);
        registry.add("spring.flyway.url", () -> "jdbc:postgresql://" + hostAndPort + "/" + database);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
    }

    private static String createDatabase() {
        String name = "switchboard_it_" + DATABASE_SEQUENCE.incrementAndGet()
            + "_" + Long.toHexString(System.nanoTime());
        try (Connection connection = POSTGRES.createConnection("");
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE DATABASE " + name);
        } catch (SQLException e) {
            throw new IllegalStateException("Cannot create per-class test database " + name, e);
        }
        return name;
    }

    // ---------------------------------------------------------------- fixtures

    /** One org + one project with the seeded dev/staging/production environments, owned by one user. */
    protected record Workspace(
        String ownerEmail,
        UUID ownerId,
        UUID orgId,
        UUID projectId,
        Map<String, UUID> environmentIds) {

        public String authorization() {
            return bearerDevToken(ownerEmail);
        }

        public UUID environmentId(String envKey) {
            UUID id = environmentIds.get(envKey);
            if (id == null) {
                throw new IllegalArgumentException("No environment " + envKey + " in this workspace");
            }
            return id;
        }
    }

    protected static String uniqueEmail(String prefix) {
        return prefix + "-" + UUID.randomUUID() + "@switchboard.test";
    }

    protected static String bearerDevToken(String email) {
        return "Bearer dev:" + email;
    }

    /** GET /api/users/me, which auto-provisions the dev-token user on first call. */
    protected UserResponse signIn(String email) {
        return http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .exchange()
            .expectStatus().isOk()
            .expectBody(UserResponse.class)
            .returnResult().getResponseBody();
    }

    protected Workspace createWorkspace(String prefix) {
        String email = uniqueEmail(prefix);
        UserResponse owner = signIn(email);
        String auth = bearerDevToken(email);

        OrgResponse org = http.post().uri("/api/orgs")
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new OrgCreateRequest(prefix + " Org"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(OrgResponse.class)
            .returnResult().getResponseBody();

        ProjectResponse project = http.post().uri("/api/orgs/{orgId}/projects", org.getId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(new ProjectCreateRequest(projectKey(prefix), prefix + " Project"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(ProjectResponse.class)
            .returnResult().getResponseBody();

        Map<String, UUID> environments = project.getEnvironments().stream()
            .collect(Collectors.toMap(EnvironmentResponse::getKey, EnvironmentResponse::getId));

        return new Workspace(email, owner.getId(), org.getId(), project.getId(), environments);
    }

    protected FlagDetailResponse createBooleanFlag(Workspace workspace, String key) {
        return createFlag(workspace, new FlagCreateRequest(key, key, FlagKind.BOOLEAN));
    }

    protected FlagDetailResponse createStringFlag(Workspace workspace, String key, List<String> values) {
        return createFlag(workspace, new FlagCreateRequest(key, key, FlagKind.STRING)
            .variations(values.stream().map(value -> new VariationCreate(value).name(value)).toList()));
    }

    private FlagDetailResponse createFlag(Workspace workspace, FlagCreateRequest request) {
        return http.post().uri("/api/projects/{projectId}/flags", workspace.projectId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(request)
            .exchange()
            .expectStatus().isCreated()
            .expectBody(FlagDetailResponse.class)
            .returnResult().getResponseBody();
    }

    /** Provisions a user (dev-token auto-provision) and returns their id. */
    protected UUID provisionUser(String email) {
        return signIn(email).getId();
    }

    /** Adds an existing user to the workspace's org with a legacy OWNER/MEMBER role. */
    protected void addOrgMember(Workspace workspace, String email, OrgRole role) {
        provisionUser(email);
        http.post().uri("/api/orgs/{orgId}/members", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new OrgMemberAddRequest(email, role))
            .exchange()
            .expectStatus().isCreated();
    }

    /**
     * Grants a scoped role. The target user need not be an org member: a scoped
     * assignment is itself standing, which is the point of the model.
     */
    protected RoleAssignmentResponse grantRole(
        Workspace workspace, String email, ScopeType scopeType, UUID scopeId, String roleKey) {
        provisionUser(email);
        return http.post().uri("/api/orgs/{orgId}/role-assignments", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new RoleAssignmentCreateRequest(scopeType, scopeId, roleKey).email(email))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(RoleAssignmentResponse.class)
            .returnResult().getResponseBody();
    }

    /** Turns approval on for one environment. */
    protected void requireApproval(
        Workspace workspace, String envKey, int minApprovals, boolean allowSelfApproval) {
        setApprovalSettings(workspace, envKey, new ApprovalSettingsUpdateRequest()
            .requireApproval(true)
            .minApprovals(minApprovals)
            .allowSelfApproval(allowSelfApproval));
    }

    protected ApprovalSettingsResponse setApprovalSettings(
        Workspace workspace, String envKey, ApprovalSettingsUpdateRequest request) {
        return http.put().uri("/api/environments/{envId}/approval-settings", workspace.environmentId(envKey))
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(request)
            .exchange()
            .expectStatus().isOk()
            .expectBody(ApprovalSettingsResponse.class)
            .returnResult().getResponseBody();
    }

    /** The head config version of one flag in one environment, straight from the table. */
    protected int headVersion(UUID flagId, UUID environmentId) {
        return selectOne("""
                SELECT version FROM flag_env_configs
                WHERE flag_id = :flagId AND environment_id = :envId
                """, Integer.class, Map.of("flagId", flagId, "envId", environmentId));
    }

    /** A full targeting-config write body that only changes which variation is served. */
    protected FlagEnvConfigUpdateRequest serveRequest(
        FlagDetailResponse flag, String envKey, String value, Integer expectedVersion) {
        FlagEnvConfigResponse current = envConfig(flag, envKey);
        return new FlagEnvConfigUpdateRequest(true, new FlagTargetingConfig(
            new RolloutOrVariation().variationId(variationId(flag, value)),
            current.getConfig().getOffVariationId(),
            current.getConfig().getDefaultVariationId()))
            .expectedVersion(expectedVersion)
            .comment("serve " + value);
    }

    /** Mints an SDK key for one environment; the full key is only ever returned here. */
    protected String mintSdkKey(Workspace workspace, String envKey) {
        return mintSdkKeyResponse(workspace, envKey).getKey();
    }

    protected SdkKeyCreatedResponse mintSdkKeyResponse(Workspace workspace, String envKey) {
        return http.post()
            .uri("/api/environments/{envId}/sdk-keys", workspace.environmentId(envKey))
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new SdkKeyCreateRequest().label(envKey + " key"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(SdkKeyCreatedResponse.class)
            .returnResult().getResponseBody();
    }

    /** One environment's head config from a flag detail response. */
    protected static FlagEnvConfigResponse envConfig(FlagDetailResponse flag, String envKey) {
        return flag.getEnvConfigs().stream()
            .filter(config -> envKey.equals(config.getEnvKey()))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("No config for environment " + envKey));
    }

    /** The id of the variation carrying {@code value} on a flag detail response. */
    protected static UUID variationId(FlagDetailResponse flag, String value) {
        return flag.getVariations().stream()
            .filter(variation -> value.equals(variation.getValue()))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("No variation with value " + value))
            .getId();
    }

    // ---------------------------------------------------------------- sql helpers

    /** The environment's monotonic change cursor, bumped once per flag-config write. */
    protected long stateVersion(UUID environmentId) {
        return selectOne("SELECT state_version FROM environments WHERE id = :envId",
            Long.class, Map.of("envId", environmentId));
    }

    /** Single row, first column. Returns null when the query matches nothing. */
    protected <T> T selectOne(String sql, Class<T> type, Map<String, Object> parameters) {
        return bind(sql, parameters).map(row -> row.get(0, type)).one().block(DB_TIMEOUT);
    }

    /** Every row's first column, in query order. */
    protected <T> List<T> selectColumn(String sql, Class<T> type, Map<String, Object> parameters) {
        return bind(sql, parameters).map(row -> row.get(0, type)).all().collectList().block(DB_TIMEOUT);
    }

    protected void execute(String sql, Map<String, Object> parameters) {
        bind(sql, parameters).then().block(DB_TIMEOUT);
    }

    private DatabaseClient.GenericExecuteSpec bind(String sql, Map<String, Object> parameters) {
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql);
        for (Map.Entry<String, Object> parameter : parameters.entrySet()) {
            spec = spec.bind(parameter.getKey(), parameter.getValue());
        }
        return spec;
    }

    private static String projectKey(String prefix) {
        String key = prefix.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-");
        return key.isEmpty() ? "project" : key;
    }
}
