package com.switchboard.application.scim;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.cache.CacheName;
import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.application.org.OrgService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.user.ScimUser;
import com.switchboard.domain.user.ScimUserRepository;
import com.switchboard.domain.user.UserRepository;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/**
 * SCIM 2.0 user provisioning.
 *
 * <h2>What this deliberately does not do</h2>
 *
 * <p><b>No {@code /Groups}.</b> Roles stay assigned in Switchboard. Mapping IdP groups onto role
 * assignments collides with the rule that permissions are a UNION across org, project and
 * environment scopes: removing someone from a group would have to work out which of their grants
 * came from that group and which a human made deliberately, and getting that wrong either strips
 * access a person still needs or leaves access they should have lost. That is a decision worth
 * making explicitly rather than inferring.
 *
 * <p><b>No hard delete.</b> SCIM's {@code DELETE} and its {@code active: false} patch both
 * deactivate. Audit entries name their actor and change requests name their approver; deleting
 * the person who did those things would orphan the record of who authorised a production change,
 * which is the opposite of what an org running SCIM for compliance reasons wants.
 *
 * <h2>Authentication</h2>
 *
 * <p>A personal access token belonging to a user with {@link Permission#MANAGE_MEMBERS} in the
 * org. No new credential type, deliberately: DECISIONS.md records that a second authorization
 * vocabulary is a second place for a permission bug to live, and the existing advice for
 * narrowing a token - create a user with a narrow role and mint it as them - is exactly right
 * for a provisioning integration.
 */
@Service
public class ScimUserService {

    /** SCIM's own default page size. Callers may ask for less; more is capped. */
    public static final int DEFAULT_COUNT = 100;
    private static final int MAX_COUNT = 200;

    private final ScimUserRepository scimUsers;
    private final UserRepository users;
    private final OrgAccessService access;
    private final OrgService orgs;
    private final AuditWriter audit;
    private final CacheInvalidationPublisher cacheInvalidation;
    private final TransactionalOperator tx;
    private final String defaultRole;

    public ScimUserService(
        ScimUserRepository scimUsers,
        UserRepository users,
        OrgAccessService access,
        OrgService orgs,
        AuditWriter audit,
        CacheInvalidationPublisher cacheInvalidation,
        TransactionalOperator tx,
        @Value("${switchboard.scim.default-role:MEMBER}") String defaultRole) {
        this.scimUsers = scimUsers;
        this.users = users;
        this.access = access;
        this.orgs = orgs;
        this.audit = audit;
        this.cacheInvalidation = cacheInvalidation;
        this.tx = tx;
        this.defaultRole = defaultRole;
    }

    /** One page. SCIM is 1-indexed, which is the single most common integration bug here. */
    public Mono<Page> list(UUID orgId, UUID callerId, String emailFilter, int startIndex, int count) {
        int safeCount = count <= 0 ? DEFAULT_COUNT : Math.min(count, MAX_COUNT);
        int safeStart = Math.max(1, startIndex);
        return access.requireOrgPermission(orgId, callerId, Permission.MANAGE_MEMBERS)
            .then(Mono.zip(
                scimUsers.listInOrg(orgId, normaliseEmail(emailFilter), safeStart, safeCount).collectList(),
                scimUsers.countInOrg(orgId, normaliseEmail(emailFilter))))
            .map(t -> new Page(t.getT1(), t.getT2(), safeStart, safeCount));
    }

    public Mono<ScimUser> get(UUID orgId, UUID callerId, UUID userId) {
        return access.requireOrgPermission(orgId, callerId, Permission.MANAGE_MEMBERS)
            .then(scimUsers.findInOrgById(orgId, userId))
            .switchIfEmpty(Mono.error(new NotFoundException("No such user in this organization")));
    }

    /**
     * Creates or ADOPTS.
     *
     * <p>An IdP pushing a person who already has a Switchboard account - because they signed in
     * before SCIM was turned on, which is the normal order of events - must not produce a second
     * account. SCIM says a duplicate {@code userName} is a 409, and that is the right answer only
     * when the existing user is already a member of this org. When they exist but are not a
     * member, the correct behaviour is to add them, which is also what an admin would do by hand.
     */
    public Mono<ScimUser> create(UUID orgId, UUID callerId, String email, String displayName,
        String externalId, boolean active) {

        String normalised = normaliseEmail(email);
        if (normalised == null) {
            throw new ValidationException("userName is required");
        }
        return access.requireOrgPermission(orgId, callerId, Permission.MANAGE_MEMBERS)
            .flatMap(orgAccess -> scimUsers.findInOrgByEmail(orgId, normalised)
                .flatMap(existing -> Mono.<ScimUser>error(new ConflictException(
                    "A user with that userName already belongs to this organization")))
                .switchIfEmpty(Mono.defer(() ->
                    users.findByEmailPreferringReal(normalised)
                        .switchIfEmpty(users.create(normalised, displayName))
                        .flatMap(user -> orgs.provisionMember(orgId, user.id(), defaultRole, "scim")
                            .then(externalId == null
                                ? scimUsers.findInOrgById(orgId, user.id())
                                : scimUsers.setExternalId(user.id(), externalId))
                            .flatMap(created -> active
                                ? Mono.just(created)
                                : scimUsers.setDeactivatedAt(user.id(), Instant.now()))
                            .flatMap(created -> audit.insert(orgId, null, null, null,
                                    "SCIM_PROVISION", "scim", "provisioned " + normalised,
                                    null, null, null)
                                .thenReturn(created)))))
                .as(tx::transactional));
    }

    /** PUT: replace the mutable attributes. Absent means absent, per SCIM's replace semantics. */
    public Mono<ScimUser> replace(UUID orgId, UUID callerId, UUID userId,
        String email, String displayName, String externalId, boolean active) {

        return get(orgId, callerId, userId)
            .flatMap(existing -> scimUsers
                .updateProfile(userId, normaliseEmail(email), displayName)
                .flatMap(updated -> externalId == null
                    ? Mono.just(updated)
                    : scimUsers.setExternalId(userId, externalId))
                .flatMap(updated -> applyActive(orgId, updated, active))
                .as(tx::transactional));
    }

    /**
     * PATCH, narrowed to what IdPs actually send.
     *
     * <p>Okta and Entra use PATCH almost exclusively to flip {@code active}, which is the
     * deprovisioning path and the one that has to be right. Other attribute patches are applied
     * when present and ignored when not, rather than rejected: an IdP that sends a field this
     * does not model should not have its deprovisioning fail because of it.
     */
    public Mono<ScimUser> patch(UUID orgId, UUID callerId, UUID userId,
        Boolean active, String email, String displayName) {

        return get(orgId, callerId, userId)
            .flatMap(existing -> Mono.just(existing)
                .flatMap(user -> email == null && displayName == null
                    ? Mono.just(user)
                    : scimUsers.updateProfile(userId, normaliseEmail(email), displayName))
                .flatMap(user -> active == null ? Mono.just(user) : applyActive(orgId, user, active))
                .as(tx::transactional));
    }

    /** SCIM DELETE. Deactivates; see the class note on why this is not a delete. */
    public Mono<Void> deactivate(UUID orgId, UUID callerId, UUID userId) {
        return get(orgId, callerId, userId)
            .flatMap(user -> applyActive(orgId, user, false))
            .then();
    }

    /**
     * Flips active, and evicts the caches that would otherwise keep a deprovisioned person
     * working.
     *
     * <p><b>The eviction is the security-relevant half.</b> Identity resolution is cached for
     * five minutes, so without this a user deactivated by an IdP would keep authenticating for
     * up to five minutes after their employer believed access was revoked - which is exactly the
     * window deprovisioning exists to close. Permissions go too, because org membership feeds
     * permission resolution.
     *
     * <p>Cleared wholesale rather than by key: the identity cache is keyed by (issuer, subject)
     * and SCIM knows neither - it deals in users, and a person may hold several identities. The
     * writes that trigger this are rare enough that a re-resolve burst costs nothing.
     */
    private Mono<ScimUser> applyActive(UUID orgId, ScimUser user, boolean active) {
        if (user.active() == active) {
            return Mono.just(user);
        }
        return scimUsers.setDeactivatedAt(user.id(), active ? null : Instant.now())
            .flatMap(updated -> audit.insert(orgId, null, null, null,
                    active ? "SCIM_ACTIVATE" : "SCIM_DEACTIVATE", "scim",
                    (active ? "reactivated " : "deactivated ") + user.email(), null, null, null)
                .thenReturn(updated))
            .doOnSuccess(ignored -> {
                cacheInvalidation.evictAll(CacheName.USER_IDENTITY);
                cacheInvalidation.evictAll(CacheName.PERMISSIONS);
            });
    }

    /** Emails are matched case-insensitively; IdPs are not consistent about case. */
    private static String normaliseEmail(String email) {
        return email == null || email.isBlank() ? null : email.trim().toLowerCase(Locale.ROOT);
    }

    /** One page of results plus what SCIM's ListResponse envelope needs. */
    public record Page(List<ScimUser> resources, long totalResults, int startIndex, int itemsPerPage) {
    }
}
