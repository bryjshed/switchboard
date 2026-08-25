package com.switchboard.interfaces.security;

import com.switchboard.domain.project.SdkKeyKind;
import java.util.UUID;

/**
 * Principal for SDK-surface requests (eval, stream, events).
 *
 * <p>{@code kind} is the single place every downstream capability branch reads from, and it comes
 * from the {@code sdk_keys} row rather than from the token's prefix - the prefix is
 * attacker-supplied and a token spelled {@code sb_srv_} whose row says CLIENT must be treated as
 * CLIENT.
 */
public record SdkKeyPrincipal(
    UUID sdkKeyId, SdkKeyKind kind, UUID environmentId, UUID projectId, UUID orgId, String envKey) {

    /** True when this key is readable by whoever runs the application holding it. */
    public boolean isPublic() {
        return kind.isPublic();
    }
}
