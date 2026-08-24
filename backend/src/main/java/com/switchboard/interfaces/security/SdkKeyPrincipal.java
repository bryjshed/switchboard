package com.switchboard.interfaces.security;

import java.util.UUID;

/** Principal for SDK-surface requests (eval, stream, events). */
public record SdkKeyPrincipal(UUID sdkKeyId, UUID environmentId, UUID projectId, UUID orgId, String envKey) {
}
