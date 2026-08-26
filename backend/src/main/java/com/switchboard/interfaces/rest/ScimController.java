package com.switchboard.interfaces.rest;

// Jackson 3 (tools.jackson), NOT com.fasterxml. Spring Boot 4's WebFlux codec is Jackson 3, so
// a request body bound to a com.fasterxml JsonNode fails to deserialise with a message about
// abstract types that says nothing about the version clash underneath. Both are on the
// classpath here; only this one is what the HTTP codec speaks.
import tools.jackson.databind.JsonNode;
import com.switchboard.application.scim.ScimUserService;
import com.switchboard.domain.user.ScimUser;
import com.switchboard.interfaces.security.Principals;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * SCIM 2.0 {@code /Users}, for IdP-driven provisioning.
 *
 * <p>Hand-written rather than generated, and NOT declared in the OpenAPI document, which is a
 * departure worth stating. SCIM is its own specification with its own envelope
 * ({@code schemas}, {@code Resources}, {@code totalResults}), its own media type, its own error
 * shape and its own 1-based paging. Modelling it in the Switchboard API document would put a
 * second, foreign contract inside the one that describes this product, and generating from it
 * would fight the spec at every turn. The contract this implements is RFC 7644; the reference is
 * the RFC, not our own schema file.
 *
 * <p><b>The base path carries the org.</b> SCIM has no notion of one and every IdP lets an
 * administrator configure an arbitrary base URL, so {@code /scim/v2/orgs/{orgId}} costs nothing
 * to configure and removes the alternative - inferring the org from the token - which would be
 * ambiguous the moment a provisioning user belonged to two.
 *
 * <p>Authenticated by a personal access token whose owner holds MANAGE_MEMBERS in that org. No
 * new credential type; see {@link ScimUserService}.
 */
@RestController
public class ScimController {

    private static final String USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
    private static final String LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
    private static final String ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
    private static final String SCIM_JSON = "application/scim+json";

    /**
     * The only filter IdPs actually send: {@code userName eq "someone@example.com"}. Anything
     * else is ignored rather than rejected — a 400 on an unsupported filter turns a provisioning
     * run into a failed sync, where returning the unfiltered page merely makes it do more work.
     */
    private static final Pattern USER_NAME_EQ =
        Pattern.compile("(?i)userName\\s+eq\\s+\"([^\"]+)\"");

    private final ScimUserService scim;

    public ScimController(ScimUserService scim) {
        this.scim = scim;
    }

    @GetMapping(value = "/scim/v2/orgs/{orgId}/Users", produces = SCIM_JSON)
    public Mono<ResponseEntity<Map<String, Object>>> listUsers(
        @PathVariable UUID orgId,
        @RequestParam(name = "filter", required = false) String filter,
        @RequestParam(name = "startIndex", required = false, defaultValue = "1") int startIndex,
        @RequestParam(name = "count", required = false, defaultValue = "0") int count) {

        return Principals.currentUser()
            .flatMap(caller -> scim.list(orgId, caller.userId(), emailFromFilter(filter), startIndex, count))
            .map(page -> {
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("schemas", List.of(LIST_SCHEMA));
                body.put("totalResults", page.totalResults());
                body.put("startIndex", page.startIndex());
                body.put("itemsPerPage", page.resources().size());
                List<Map<String, Object>> resources = new ArrayList<>();
                page.resources().forEach(user -> resources.add(toScim(orgId, user)));
                body.put("Resources", resources);
                return ResponseEntity.ok().contentType(MediaType.valueOf(SCIM_JSON)).body(body);
            });
    }

    @GetMapping(value = "/scim/v2/orgs/{orgId}/Users/{userId}", produces = SCIM_JSON)
    public Mono<ResponseEntity<Map<String, Object>>> getUser(
        @PathVariable UUID orgId, @PathVariable UUID userId) {
        return Principals.currentUser()
            .flatMap(caller -> scim.get(orgId, caller.userId(), userId))
            .map(user -> ok(orgId, user));
    }

    @PostMapping(value = "/scim/v2/orgs/{orgId}/Users", produces = SCIM_JSON)
    public Mono<ResponseEntity<Map<String, Object>>> createUser(
        @PathVariable UUID orgId, @RequestBody JsonNode body) {

        return Principals.currentUser()
            .flatMap(caller -> scim.create(orgId, caller.userId(),
                text(body, "userName"),
                displayName(body),
                text(body, "externalId"),
                body.path("active").asBoolean(true)))
            .map(user -> ResponseEntity.status(HttpStatus.CREATED)
                .contentType(MediaType.valueOf(SCIM_JSON))
                .body(toScim(orgId, user)));
    }

    @PutMapping(value = "/scim/v2/orgs/{orgId}/Users/{userId}", produces = SCIM_JSON)
    public Mono<ResponseEntity<Map<String, Object>>> replaceUser(
        @PathVariable UUID orgId, @PathVariable UUID userId, @RequestBody JsonNode body) {

        return Principals.currentUser()
            .flatMap(caller -> scim.replace(orgId, caller.userId(), userId,
                text(body, "userName"),
                displayName(body),
                text(body, "externalId"),
                body.path("active").asBoolean(true)))
            .map(user -> ok(orgId, user));
    }

    /**
     * PATCH with SCIM's Operations envelope.
     *
     * <p>Only {@code replace} of {@code active} and the two profile fields are honoured, because
     * that is what Okta and Entra send — {@code active: false} being the deprovisioning path and
     * the one that must not fail. Operations naming paths this does not model are skipped rather
     * than rejected, so an IdP sending an extra attribute cannot break deprovisioning.
     */
    @PatchMapping(value = "/scim/v2/orgs/{orgId}/Users/{userId}", produces = SCIM_JSON)
    public Mono<ResponseEntity<Map<String, Object>>> patchUser(
        @PathVariable UUID orgId, @PathVariable UUID userId, @RequestBody JsonNode body) {

        // Mutable while scanning the Operations array, then copied into effectively-final
        // locals for the lambda below.
        Boolean activeFound = null;
        String emailFound = null;
        String displayNameFound = null;

        for (JsonNode operation : body.path("Operations")) {
            String op = operation.path("op").asText("").toLowerCase(Locale.ROOT);
            if (!op.equals("replace") && !op.equals("add")) {
                continue;
            }
            String path = operation.path("path").asText("");
            JsonNode value = operation.path("value");
            if ("active".equalsIgnoreCase(path)) {
                activeFound = value.asBoolean();
            } else if ("userName".equalsIgnoreCase(path)) {
                emailFound = value.asText(null);
            } else if ("displayName".equalsIgnoreCase(path)) {
                displayNameFound = value.asText(null);
            } else if (path.isEmpty() && value.isObject()) {
                // A pathless replace carries an object of attributes, which is how Entra
                // usually sends a deactivation.
                if (value.has("active")) {
                    activeFound = value.path("active").asBoolean();
                }
                if (value.has("userName")) {
                    emailFound = value.path("userName").asText(null);
                }
                if (value.has("displayName")) {
                    displayNameFound = value.path("displayName").asText(null);
                }
            }
        }

        Boolean active = activeFound;
        String email = emailFound;
        String displayName = displayNameFound;
        return Principals.currentUser()
            .flatMap(caller -> scim.patch(orgId, caller.userId(), userId, active, email, displayName))
            .map(user -> ok(orgId, user));
    }

    @DeleteMapping("/scim/v2/orgs/{orgId}/Users/{userId}")
    public Mono<ResponseEntity<Void>> deleteUser(@PathVariable UUID orgId, @PathVariable UUID userId) {
        return Principals.currentUser()
            .flatMap(caller -> scim.deactivate(orgId, caller.userId(), userId))
            .thenReturn(ResponseEntity.noContent().build());
    }

    // ---------------------------------------------------------------- mapping

    private static ResponseEntity<Map<String, Object>> ok(UUID orgId, ScimUser user) {
        return ResponseEntity.ok().contentType(MediaType.valueOf(SCIM_JSON)).body(toScim(orgId, user));
    }

    /**
     * A user in SCIM's shape. {@code userName} is the email, which is what every IdP maps to it
     * and what Switchboard keys a person on.
     */
    private static Map<String, Object> toScim(UUID orgId, ScimUser user) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schemas", List.of(USER_SCHEMA));
        body.put("id", user.id().toString());
        if (user.externalId() != null) {
            body.put("externalId", user.externalId());
        }
        body.put("userName", user.email());
        body.put("active", user.active());
        if (user.displayName() != null) {
            body.put("displayName", user.displayName());
        }
        body.put("emails", List.of(Map.of("value", user.email(), "primary", true)));
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("resourceType", "User");
        if (user.createdAt() != null) {
            meta.put("created", user.createdAt().toString());
        }
        meta.put("location", "/scim/v2/orgs/" + orgId + "/Users/" + user.id());
        body.put("meta", meta);
        return body;
    }

    static String emailFromFilter(String filter) {
        if (filter == null || filter.isBlank()) {
            return null;
        }
        Matcher matcher = USER_NAME_EQ.matcher(filter);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isMissingNode() || value.isNull() ? null : value.asText();
    }

    /** IdPs send either displayName or name.formatted; neither is guaranteed. */
    private static String displayName(JsonNode body) {
        String direct = text(body, "displayName");
        if (direct != null) {
            return direct;
        }
        JsonNode name = body.path("name");
        String formatted = text(name, "formatted");
        if (formatted != null) {
            return formatted;
        }
        String given = text(name, "givenName");
        String family = text(name, "familyName");
        if (given == null && family == null) {
            return null;
        }
        return ((given == null ? "" : given) + " " + (family == null ? "" : family)).trim();
    }

    /** The SCIM error envelope, for the handler to render. */
    public static Map<String, Object> error(int status, String detail) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schemas", List.of(ERROR_SCHEMA));
        body.put("status", String.valueOf(status));
        body.put("detail", detail);
        return body;
    }
}
