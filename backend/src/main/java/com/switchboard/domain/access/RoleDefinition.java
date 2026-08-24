package com.switchboard.domain.access;

import java.util.Set;

/** One row of {@code roles} with the permission set it grants. */
public record RoleDefinition(String key, String name, String description, boolean builtIn, Set<Permission> permissions) {
}
