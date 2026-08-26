package com.switchboard.application.org;

import com.switchboard.application.cache.CacheName;
import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import com.switchboard.application.audit.AuditWriter;
import com.switchboard.domain.access.AccessRepository;
import com.switchboard.domain.access.AccessScope;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.org.Org;
import com.switchboard.domain.org.OrgMemberView;
import com.switchboard.domain.org.OrgRepository;
import com.switchboard.domain.org.OrgWithRole;
import com.switchboard.domain.user.UserRepository;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class OrgService {

    private static final String OWNER = "OWNER";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final OrgRepository orgs;
    private final UserRepository users;
    private final OrgAccessService access;
    private final AccessRepository roles;
    private final AuditWriter audit;
    private final CacheInvalidationPublisher cacheInvalidation;
    private final TransactionalOperator tx;

    public OrgService(
        OrgRepository orgs,
        UserRepository users,
        OrgAccessService access,
        AccessRepository roles,
        AuditWriter audit,
        CacheInvalidationPublisher cacheInvalidation,
        TransactionalOperator tx) {
        this.orgs = orgs;
        this.users = users;
        this.access = access;
        this.roles = roles;
        this.audit = audit;
        this.cacheInvalidation = cacheInvalidation;
        this.tx = tx;
    }

    /** Creates the org and makes the creator its OWNER in one transaction. */
    public Mono<OrgWithRole> createOrg(String name, UUID creatorId) {
        String baseSlug = slugify(name);
        return orgs.slugExists(baseSlug)
            .map(taken -> taken ? baseSlug + "-" + randomSuffix() : baseSlug)
            .flatMap(slug -> insertOrgWithOwner(name, slug, creatorId))
            // Lost the slug race: retry once with a fresh suffixed slug (new transaction).
            .onErrorResume(DataIntegrityViolationException.class,
                e -> insertOrgWithOwner(name, baseSlug + "-" + randomSuffix(), creatorId));
    }

    private Mono<OrgWithRole> insertOrgWithOwner(String name, String slug, UUID creatorId) {
        return orgs.create(name, slug)
            .flatMap(org -> orgs.addMember(org.id(), creatorId, OWNER)
                .then(grantOrgRole(org.id(), creatorId, OWNER, "system"))
                .thenReturn(org))
            .as(tx::transactional)
            .map(org -> withRole(org, OWNER));
    }

    /**
     * Membership and the role model are kept in lockstep in one transaction: the
     * org_memberships row is still the tenancy record (it is what "my orgs" lists
     * and what the last-owner guard counts), and the ORG-scope role assignment is
     * what the permission resolver reads.
     */
    private Mono<Void> grantOrgRole(UUID orgId, UUID userId, String role, String actor) {
        return roles.grant(userId, AccessScope.org(orgId), role, actor).then();
    }

    /**
     * Adds an existing user to an org with a role, for a caller that is not a person.
     *
     * <p>Exists so SCIM provisioning goes through the SAME path as a human adding a member
     * rather than reimplementing it. The part that would be easy to leave out of a copy - and
     * expensive - is the PERMISSIONS cache eviction: membership feeds permission resolution as a
     * compatibility floor, so a provisioned user without it would be told they have no access
     * for up to the cache TTL, on their very first sign-in.
     *
     * <p>Deliberately takes a userId rather than an email: SCIM has already resolved or created
     * the person, and re-resolving by email here would reintroduce the ambiguity that
     * findByEmailPreferringReal exists to settle.
     */
    public Mono<Void> provisionMember(UUID orgId, UUID userId, String role, String actor) {
        return orgs.addMember(orgId, userId, role)
            .flatMap(member -> grantOrgRole(orgId, userId, role, actor))
            .doOnSuccess(ignored -> cacheInvalidation.evictAll(CacheName.PERMISSIONS))
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("User is already a member of this org"))
            .then();
    }

    public Flux<OrgWithRole> listOrgs(UUID userId) {
        return orgs.findAllForUser(userId);
    }

    /** Member-only; a nonexistent org is also 403 via the membership check. */
    public Mono<OrgWithRole> getOrg(UUID orgId, UUID userId) {
        return access.requireMember(orgId, userId)
            .flatMap(role -> orgs.findById(orgId).map(org -> withRole(org, role)));
    }

    public Flux<OrgMemberView> listMembers(UUID orgId, UUID userId) {
        return access.requireMember(orgId, userId)
            .flatMapMany(role -> orgs.findMembers(orgId));
    }

    public Mono<OrgMemberView> addMember(UUID orgId, AuthenticatedUser caller, String email, String role) {
        return access.requireOrgPermission(orgId, caller.userId(), Permission.MANAGE_MEMBERS)
            .then(users.findByEmailPreferringReal(email)
                .switchIfEmpty(Mono.error(new NotFoundException("No user with that email"))))
            .flatMap(target -> orgs.addMember(orgId, target.id(), role)
                .flatMap(member -> grantOrgRole(orgId, target.id(), role, caller.email())
                    .then(audit.insert(
                        orgId, null, null, null, "MEMBER_ADD", caller.email(), null, null, null, null))
                    .thenReturn(member))
                .as(tx::transactional))
            // Membership feeds permission resolution as a compatibility floor, so it invalidates
            // the same family a role grant does.
            .doOnSuccess(ignored -> cacheInvalidation.evictAll(CacheName.PERMISSIONS))
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("User is already a member of this org"));
    }

    public Mono<Void> removeMember(UUID orgId, AuthenticatedUser caller, UUID targetUserId) {
        return access.requireOrgPermission(orgId, caller.userId(), Permission.MANAGE_MEMBERS)
            .then(orgs.findMemberRole(orgId, targetUserId)
                .switchIfEmpty(Mono.error(new NotFoundException("Membership not found"))))
            .flatMap(targetRole -> guardLastOwner(orgId, targetRole)
                .then(orgs.removeMember(orgId, targetUserId))
                .then(roles.revokeAtScope(targetUserId, AccessScope.org(orgId)))
                .then(audit.insert(orgId, null, null, null, "MEMBER_REMOVE", caller.email(), null, null, null, null))
                .as(tx::transactional))
            .doOnSuccess(ignored -> cacheInvalidation.evictAll(CacheName.PERMISSIONS));
    }

    private Mono<Void> guardLastOwner(UUID orgId, String targetRole) {
        if (!OWNER.equals(targetRole)) {
            return Mono.empty();
        }
        return orgs.countByRole(orgId, OWNER)
            .flatMap(owners -> owners <= 1
                ? Mono.error(new ConflictException("Cannot remove the last OWNER of an org"))
                : Mono.empty());
    }

    private static OrgWithRole withRole(Org org, String role) {
        return new OrgWithRole(org.id(), org.name(), org.slug(), role, org.createdAt());
    }

    /** Lowercases and maps every non-alphanumeric run to a single '-'. */
    static String slugify(String name) {
        String slug = name.toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("(^-+|-+$)", "");
        return slug.isEmpty() ? "org-" + randomSuffix() : slug;
    }

    private static String randomSuffix() {
        byte[] bytes = new byte[3];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
