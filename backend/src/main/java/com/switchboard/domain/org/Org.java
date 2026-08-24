package com.switchboard.domain.org;

import java.time.Instant;
import java.util.UUID;

public record Org(UUID id, String name, String slug, Instant createdAt) {
}
