package com.switchboard.application.scim;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.application.org.OrgService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.user.ScimUser;
import com.switchboard.domain.user.ScimUserRepository;
import com.switchboard.domain.user.User;
import com.switchboard.domain.user.UserRepository;
import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/** SCIM create adopts an existing account only when that account is verified. */
class ScimUserServiceAdoptionTest {

    private static final String EMAIL = "employee@acme.test";

    private final UUID orgId = UUID.randomUUID();
    private final UUID callerId = UUID.randomUUID();
    private ScimUserRepository scimUsers;
    private UserRepository users;
    private OrgService orgs;
    private ScimUserService service;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        scimUsers = mock(ScimUserRepository.class);
        users = mock(UserRepository.class);
        orgs = mock(OrgService.class);
        OrgAccessService access = mock(OrgAccessService.class);
        AuditWriter audit = mock(AuditWriter.class);
        TransactionalOperator tx = mock(TransactionalOperator.class);
        lenient().when(tx.transactional(any(Mono.class))).thenAnswer(inv -> inv.getArgument(0));
        when(access.requireOrgPermission(orgId, callerId, Permission.MANAGE_MEMBERS)).thenReturn(Mono.just("OWNER"));
        when(scimUsers.findInOrgByEmail(orgId, EMAIL)).thenReturn(Mono.empty());
        lenient().when(orgs.provisionMember(any(), any(), anyString(), anyString())).thenReturn(Mono.empty());
        lenient().when(scimUsers.findInOrgById(any(), any())).thenAnswer(inv -> Mono.just(
            new ScimUser(inv.getArgument(1), EMAIL, null, null, null, Instant.now())));
        lenient().when(audit.insert(any(), any(), any(), any(), anyString(), anyString(), any(), any(), any(), any()))
            .thenReturn(Mono.empty());
        service = new ScimUserService(scimUsers, users, access, orgs, audit,
            mock(CacheInvalidationPublisher.class), tx, "MEMBER");
    }

    @Test
    void aVerifiedAccountIsAdopted() {
        User verified = new User(UUID.randomUUID(), EMAIL, null, false, false);
        when(users.findVerifiedByEmail(EMAIL)).thenReturn(Mono.just(verified));

        ScimUser result = service.create(orgId, callerId, EMAIL, null, null, true).block();

        assertThat(result.id()).isEqualTo(verified.id());
        verify(orgs).provisionMember(orgId, verified.id(), "MEMBER", "scim");
        verify(users, never()).createScimProvisioned(anyString(), any());
    }

    @Test
    void anUnverifiedAccountIsNotAdoptedAndANewScimAccountIsCreatedBesideIt() {
        User squatter = new User(UUID.randomUUID(), EMAIL, null, false, false);
        User fresh = new User(UUID.randomUUID(), EMAIL, null, false, false);
        lenient().when(users.findByEmailPreferringReal(EMAIL)).thenReturn(Mono.just(squatter));
        when(users.findVerifiedByEmail(EMAIL)).thenReturn(Mono.empty());
        when(users.createScimProvisioned(EMAIL, null)).thenReturn(Mono.just(fresh));

        ScimUser result = service.create(orgId, callerId, EMAIL, null, null, true).block();

        assertThat(result.id()).isEqualTo(fresh.id());
        verify(orgs).provisionMember(orgId, fresh.id(), "MEMBER", "scim");
        verify(orgs, never()).provisionMember(orgId, squatter.id(), "MEMBER", "scim");
    }
}
