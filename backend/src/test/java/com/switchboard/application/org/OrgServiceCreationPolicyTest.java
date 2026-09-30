package com.switchboard.application.org;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.domain.access.AccessRepository;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.domain.org.Org;
import com.switchboard.domain.org.OrgMemberView;
import com.switchboard.domain.org.OrgRepository;
import com.switchboard.domain.org.OrgWithRole;
import com.switchboard.domain.user.UserRepository;
import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/** {@code switchboard.org-creation}: open lets anyone create an org, bootstrap only the first. */
class OrgServiceCreationPolicyTest {

    private final UUID creator = UUID.randomUUID();
    private OrgRepository orgs;
    private AccessRepository roles;
    private TransactionalOperator tx;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        orgs = mock(OrgRepository.class);
        roles = mock(AccessRepository.class);
        tx = mock(TransactionalOperator.class);
        lenient().when(tx.transactional(any(Mono.class))).thenAnswer(inv -> inv.getArgument(0));
        lenient().when(orgs.slugExists(anyString())).thenReturn(Mono.just(false));
        lenient().when(orgs.create(anyString(), anyString())).thenAnswer(inv -> Mono.just(
            new Org(UUID.randomUUID(), inv.getArgument(0), inv.getArgument(1), Instant.now())));
        lenient().when(orgs.addMember(any(), eq(creator), eq("OWNER"))).thenReturn(Mono.just(
            new OrgMemberView(creator, "first@example.com", null, "OWNER", Instant.now())));
        lenient().when(roles.grant(any(), any(), anyString(), anyString())).thenReturn(Mono.empty());
        lenient().when(orgs.lockCreation()).thenReturn(Mono.empty());
    }

    private OrgService service(OrgCreationPolicy policy) {
        return new OrgService(orgs, mock(UserRepository.class), mock(OrgAccessService.class), roles,
            mock(AuditWriter.class), mock(CacheInvalidationPublisher.class), tx, policy);
    }

    @Test
    void openCreatesWithoutConsultingExistingOrgs() {
        OrgWithRole org = service(OrgCreationPolicy.OPEN).createOrg("Acme", creator).block();

        assertThat(org.role()).isEqualTo("OWNER");
        assertThat(service(OrgCreationPolicy.OPEN).canCreateOrg().block()).isTrue();
        verify(orgs, never()).anyExists();
        verify(orgs, never()).lockCreation();
    }

    @Test
    void bootstrapLetsTheFirstUserCreateUnderTheLock() {
        when(orgs.anyExists()).thenReturn(Mono.just(false));

        OrgWithRole org = service(OrgCreationPolicy.BOOTSTRAP).createOrg("Acme", creator).block();

        assertThat(org.name()).isEqualTo("Acme");
        // The lock must be taken BEFORE the existence check, or two first users both see "none".
        InOrder order = inOrder(orgs);
        order.verify(orgs).lockCreation();
        order.verify(orgs).anyExists();
        order.verify(orgs).create("Acme", "acme");
        assertThat(service(OrgCreationPolicy.BOOTSTRAP).canCreateOrg().block()).isTrue();
    }

    @Test
    void bootstrapRefusesOnceAnOrgExists() {
        when(orgs.anyExists()).thenReturn(Mono.just(true));
        OrgService service = service(OrgCreationPolicy.BOOTSTRAP);

        assertThatThrownBy(() -> service.createOrg("Second", creator).block())
            .isInstanceOf(ForbiddenException.class)
            .hasMessage(OrgService.CREATION_DISABLED);
        verify(orgs, never()).create(anyString(), anyString());
        assertThat(service.canCreateOrg().block()).isFalse();
    }

    @Test
    void policyParsesCaseInsensitivelyAndRejectsTypos() {
        assertThat(OrgCreationPolicy.parse("open")).isEqualTo(OrgCreationPolicy.OPEN);
        assertThat(OrgCreationPolicy.parse(" Bootstrap ")).isEqualTo(OrgCreationPolicy.BOOTSTRAP);
        assertThat(OrgCreationPolicy.parse("")).isEqualTo(OrgCreationPolicy.OPEN);
        assertThat(OrgCreationPolicy.parse(null)).isEqualTo(OrgCreationPolicy.OPEN);
        assertThatThrownBy(() -> OrgCreationPolicy.parse("closed"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("closed");
    }
}
