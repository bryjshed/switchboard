package com.switchboard.domain.ai;

import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.TargetingConfig;
import java.time.Instant;
import java.util.UUID;

/**
 * A live flag-env head the monitor should look at, with everything it needs.
 *
 * @param epochStartedAt when this flag-env last changed its traffic allocation, and therefore
 *     when the current evidence window opened. The anytime-valid statistic accumulates from
 *     here rather than over a rolling window: a rolling window is not a filtration - entries
 *     leave it - so the supermartingale argument that makes repeated looks safe does not
 *     apply to one. A weight change also changes which populations the arms contain, so
 *     evidence gathered across that boundary is testing a null that no longer exists.
 *     <p>Null when no config version row can be found, which should not happen for a head
 *     that exists; the monitor treats that as "cannot measure" rather than guessing.
 */
public record RolloutCandidate(
    UUID orgId,
    UUID projectId,
    UUID environmentId,
    String envKey,
    Flag flag,
    TargetingConfig config,
    boolean enabled,
    boolean killSwitchActive,
    int version,
    Instant epochStartedAt) {
}
