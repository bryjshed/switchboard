package com.switchboard.interfaces.security;

import java.util.UUID;

/** Principal for management-surface requests (Firebase or dev-token auth). */
public record AuthenticatedUser(UUID userId, String email) {
}
