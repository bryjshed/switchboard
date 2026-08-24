package com.switchboard.domain.project;

import java.time.Instant;
import java.util.UUID;

public record Project(UUID id, UUID orgId, String key, String name, Instant createdAt) {
}
