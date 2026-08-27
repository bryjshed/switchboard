package com.switchboard.domain.project;

import java.time.Instant;
import java.util.UUID;

/**
 * An environment row, including its approval policy (see {@link ApprovalSettings}).
 *
 * <p>{@code archivedAt} is set when the environment has been retired. Archiving hides it from
 * pickers and freezes it against ordinary config writes, but it KEEPS SERVING: SDK keys pointed
 * at it still evaluate, because tidying the dashboard must not take an environment down. That is
 * also why the kill switch remains available on an archived environment - it is the one write
 * that has to work when something is still serving traffic.
 */
public record Environment(
    UUID id,
    UUID projectId,
    String key,
    String name,
    long stateVersion,
    ApprovalSettings approvals,
    Instant createdAt,
    Instant archivedAt) {

    public boolean archived() {
        return archivedAt != null;
    }
}
