package com.switchboard.domain.project;

import java.util.List;

/** Read model: a project with its environments embedded. */
public record ProjectWithEnvironments(Project project, List<Environment> environments) {
}
