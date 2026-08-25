package com.switchboard.application.project;

import com.switchboard.application.audit.AuditWriter;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.project.SdkKey;
import com.switchboard.domain.project.SdkKeyKind;
import com.switchboard.domain.project.SdkKeyRepository;
import com.switchboard.interfaces.security.AuthenticatedUser;
import com.switchboard.interfaces.security.SwitchboardAuthenticationManager;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class SdkKeyService {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int PREFIX_LENGTH = 12;

    private final SdkKeyRepository keys;
    private final OrgAccessService access;
    private final AuditWriter audit;
    private final TransactionalOperator tx;

    public SdkKeyService(
        SdkKeyRepository keys,
        OrgAccessService access,
        AuditWriter audit,
        TransactionalOperator tx) {
        this.keys = keys;
        this.access = access;
        this.audit = audit;
        this.tx = tx;
    }

    /**
     * Mints a key for the environment. The full key is returned once and never stored.
     *
     * <p>The hash is still SHA-256 for every kind, including the public ones. Hashing a value that
     * is going to be published is not theatre: it means a database leak does not hand over live
     * credentials, and it keeps one lookup path for all kinds. What changes for a public key is the
     * threat model, not the storage - see {@link SdkKeyKind}.
     */
    public Mono<CreatedSdkKey> create(
        UUID environmentId, AuthenticatedUser caller, String label, SdkKeyKind kind) {
        SdkKeyKind minted = kind == null ? SdkKeyKind.SERVER : kind;
        if (!minted.isMintable()) {
            return Mono.error(new ValidationException(
                minted + " keys cannot be minted yet: no SDK holds one."));
        }
        return access.requireEnvironmentPermission(environmentId, caller.userId(), Permission.MANAGE_SDK_KEYS)
            .flatMap(env -> {
                String fullKey = minted.prefix() + env.environmentKey() + "_" + randomHex();
                String prefix = fullKey.substring(0, PREFIX_LENGTH) + "…";
                String hash = SwitchboardAuthenticationManager.sha256(fullKey);
                return keys.create(environmentId, minted, prefix, hash, label, caller.email())
                    .flatMap(stored -> audit
                        .insert(env.orgId(), env.projectId(), environmentId, null,
                            "SDK_KEY_CREATE", caller.email(), null, null, null, null)
                        .thenReturn(new CreatedSdkKey(stored, fullKey)))
                    .as(tx::transactional);
            });
    }

    public Flux<SdkKey> list(UUID environmentId, UUID userId) {
        return access.requireEnvironmentMember(environmentId, userId)
            .thenMany(Flux.defer(() -> keys.findByEnvironment(environmentId)));
    }

    /** Sets revoked_at; idempotent for an already-revoked key. */
    public Mono<Void> revoke(UUID keyId, AuthenticatedUser caller) {
        return keys.findById(keyId)
            .switchIfEmpty(Mono.error(new NotFoundException("SDK key not found")))
            .flatMap(key -> access.requireEnvironmentPermission(key.environmentId(), caller.userId(), Permission.MANAGE_SDK_KEYS)
                .flatMap(env -> keys.revoke(keyId)
                    .flatMap(revoked -> audit.insert(
                        env.orgId(), env.projectId(), key.environmentId(), null,
                        "SDK_KEY_REVOKE", caller.email(), null, null, null, null))
                    .as(tx::transactional)));
    }

    private static String randomHex() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
