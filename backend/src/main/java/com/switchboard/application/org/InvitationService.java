package com.switchboard.application.org;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.cache.CacheName;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.org.OrgInvitation;
import com.switchboard.domain.org.OrgInvitationRepository;
import com.switchboard.domain.org.OrgRepository;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserRepository;
import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import com.switchboard.interfaces.security.AuthenticatedUser;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Org invitations: how somebody who has never signed in becomes a member.
 *
 * <p>{@code POST /members} can only add a person who already has a {@code users} row, which on a
 * fresh instance is nobody. An invitation is the row that exists in the meantime. The invitee's
 * first sign-in with a <em>verified</em> email (or a local dev token) turns every pending
 * invitation for that address into a membership - see {@link #acceptPendingFor}. No email is
 * sent; the admin shares the dashboard URL.
 *
 * <p>Inviting an address that already has a verified account skips the pending state and adds
 * them at once, which is what {@code POST /members} would have done, so one endpoint covers both cases
 * and the dashboard does not have to guess which to call.
 */
@Service
public class InvitationService {

    private static final Logger log = LoggerFactory.getLogger(InvitationService.class);
    private static final Set<String> ROLES = Set.of("OWNER", "MEMBER");

    private final OrgInvitationRepository invitations;
    private final OrgRepository orgs;
    private final UserRepository users;
    private final OrgService orgService;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final CacheInvalidationPublisher cacheInvalidation;
    private final TransactionalOperator tx;

    public InvitationService(
        OrgInvitationRepository invitations,
        OrgRepository orgs,
        UserRepository users,
        OrgService orgService,
        OrgAccessService access,
        AuditWriter audit,
        CacheInvalidationPublisher cacheInvalidation,
        TransactionalOperator tx) {
        this.invitations = invitations;
        this.orgs = orgs;
        this.users = users;
        this.orgService = orgService;
        this.access = access;
        this.audit = audit;
        this.cacheInvalidation = cacheInvalidation;
        this.tx = tx;
    }

    /**
     * Invites {@code email} with {@code role}. Emits a PENDING invitation, or an ACCEPTED one when
     * the address already belonged to a user and they were added on the spot.
     *
     * <p>"Already had an account" means a VERIFIED account (see {@code UserRepository
     * #findVerifiedByEmail}); an unverified one is invited like a stranger. 409 when someone
     * with that email is already a member, or when an invitation for the address is already
     * pending.
     */
    public Mono<OrgInvitation> invite(UUID orgId, AuthenticatedUser caller, String email, String role) {
        String normalised = normaliseEmail(email);
        if (normalised == null || !normalised.contains("@")) {
            return Mono.error(new ValidationException("A valid email address is required"));
        }
        if (!ROLES.contains(role)) {
            return Mono.error(new ValidationException("role must be OWNER or MEMBER"));
        }
        return access.requireOrgPermission(orgId, caller.userId(), Permission.MANAGE_MEMBERS)
            .then(Mono.defer(() -> orgs.hasMemberWithEmail(orgId, normalised)))
            .flatMap(alreadyMember -> alreadyMember
                ? Mono.<OrgInvitation>error(new ConflictException(
                    "Someone with that email is already a member of this org"))
                // Only a VERIFIED account is added on the spot. An unverified one may belong to
                // whoever signed up with the address first, so it gets a pending invitation like
                // a stranger would, accepted once a verified token for the address signs in.
                : users.findVerifiedByEmail(normalised)
                    .flatMap(user -> addExistingUser(orgId, caller, normalised, role, user))
                    .switchIfEmpty(Mono.defer(() -> createPending(orgId, caller, normalised, role))));
    }

    /** Pending invitations in the org, oldest first. Same gate as managing members. */
    public Flux<OrgInvitation> listPending(UUID orgId, AuthenticatedUser caller) {
        return access.requireOrgPermission(orgId, caller.userId(), Permission.MANAGE_MEMBERS)
            .thenMany(Flux.defer(() -> invitations.findPendingInOrg(orgId)));
    }

    /** Revokes a pending invitation. 404 when it is not pending in this org (or never existed). */
    public Mono<Void> revoke(UUID orgId, AuthenticatedUser caller, UUID invitationId) {
        return access.requireOrgPermission(orgId, caller.userId(), Permission.MANAGE_MEMBERS)
            .then(Mono.defer(() -> invitations.revoke(orgId, invitationId)
                .switchIfEmpty(Mono.error(new NotFoundException("No pending invitation with that id")))
                .flatMap(revoked -> audit.insert(orgId, null, null, null, "INVITE_REVOKE", caller.email(),
                    "revoked the invitation for " + revoked.email(), null, null, null))
                .as(tx::transactional)));
    }

    /**
     * Turns every pending invitation for {@code verifiedEmail} into a membership for {@code user}.
     *
     * <p>The caller - {@code UserService} at sign-in - is responsible for only passing an email
     * the identity provider vouched for; this method trusts it. Each invitation is accepted in
     * its own transaction and a failure is logged and skipped, so one bad row cannot keep the
     * person out of the others (nor, since the caller swallows errors too, out of the product).
     *
     * <p>A person who is already a member - most often because SCIM provisioned them between the
     * invite and the first sign-in - keeps the role they have. The invitation is still marked
     * accepted, but nothing is granted: {@code grant} is an upsert, and re-running it would
     * silently overwrite the IdP's role with the invitation's.
     *
     * @return the invitations this call accepted
     */
    public Flux<OrgInvitation> acceptPendingFor(User user, String verifiedEmail) {
        String email = normaliseEmail(verifiedEmail);
        if (user.deactivated() || email == null) {
            return Flux.empty();
        }
        return invitations.findPendingByEmail(email).collectList()
            .flatMapMany(pending -> acceptAll(pending, user));
    }

    /**
     * The same, for a session that already has a user id but not the user row - {@code GET
     * /api/users/me}. The pending lookup comes first and is an index probe on a partial index that
     * is empty for almost everyone, so the user row is only loaded when there is something to
     * accept.
     */
    public Flux<OrgInvitation> acceptPendingForSession(UUID userId, String verifiedEmail) {
        String email = normaliseEmail(verifiedEmail);
        if (email == null) {
            return Flux.empty();
        }
        return invitations.findPendingByEmail(email).collectList()
            .flatMapMany(pending -> pending.isEmpty()
                ? Flux.<OrgInvitation>empty()
                : users.findById(userId)
                    .filter(user -> !user.deactivated())
                    .flatMapMany(user -> acceptAll(pending, user)));
    }

    private Flux<OrgInvitation> acceptAll(java.util.List<OrgInvitation> pending, User user) {
        return Flux.fromIterable(pending)
            .concatMap(invitation -> acceptOne(invitation, user)
                .onErrorResume(e -> {
                    log.warn("Could not accept invitation {} for user {}: {}",
                        invitation.id(), user.id(), e.toString());
                    return Mono.empty();
                }));
    }

    private Mono<OrgInvitation> acceptOne(OrgInvitation pending, User user) {
        // markAccepted is conditional on the row still being pending, so a concurrent sign-in or
        // revoke that got there first leaves this one with nothing to do.
        return invitations.markAccepted(pending.id(), user.id())
            .flatMap(accepted -> orgs.findMemberRole(accepted.orgId(), user.id()).hasElement()
                .flatMap(alreadyMember -> (alreadyMember
                        ? Mono.<Void>empty()
                        : orgService.provisionMember(accepted.orgId(), user.id(), accepted.role(),
                            accepted.invitedBy()))
                    .then(audit.insert(accepted.orgId(), null, null, null, "INVITE_ACCEPT", user.email(),
                        alreadyMember
                            ? "accepted the invitation from " + accepted.invitedBy()
                                + "; already a member, role unchanged"
                            : "joined as " + accepted.role() + ", invited by " + accepted.invitedBy(),
                        null, null, null)))
                .thenReturn(accepted))
            .as(tx::transactional)
            // provisionMember evicts too, but from inside the transaction; this one is after commit.
            .doOnNext(accepted -> cacheInvalidation.evictAll(CacheName.PERMISSIONS));
    }

    private Mono<OrgInvitation> addExistingUser(
        UUID orgId, AuthenticatedUser caller, String email, String role, User user) {
        return orgs.findMemberRole(orgId, user.id()).hasElement()
            .flatMap(alreadyMember -> alreadyMember
                ? Mono.<OrgInvitation>error(new ConflictException("That user is already a member of this org"))
                : orgService.provisionMember(orgId, user.id(), role, caller.email())
                    // Any invitation still pending for the address is settled by this one.
                    .thenMany(invitations.markPendingAccepted(orgId, email, user.id()))
                    .then(invitations.createAccepted(orgId, email, role, caller.email(), user.id()))
                    .flatMap(created -> audit.insert(orgId, null, null, null, "MEMBER_ADD", caller.email(),
                            "invited " + email + " as " + role + "; they already had an account",
                            null, null, null)
                        .thenReturn(created))
                    .as(tx::transactional))
            .doOnNext(created -> cacheInvalidation.evictAll(CacheName.PERMISSIONS));
    }

    private Mono<OrgInvitation> createPending(UUID orgId, AuthenticatedUser caller, String email, String role) {
        return invitations.createPending(orgId, email, role, caller.email())
            .flatMap(created -> audit.insert(orgId, null, null, null, "INVITE_CREATE", caller.email(),
                    "invited " + email + " as " + role, null, null, null)
                .thenReturn(created))
            .as(tx::transactional)
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("An invitation for that email is already pending"));
    }

    static String normaliseEmail(String email) {
        return email == null || email.isBlank() ? null : email.trim().toLowerCase(Locale.ROOT);
    }
}
