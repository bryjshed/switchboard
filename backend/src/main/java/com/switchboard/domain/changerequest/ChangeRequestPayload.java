package com.switchboard.domain.changerequest;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.switchboard.domain.flag.TargetingConfig;

/**
 * The proposed write, in the shape FlagTargetingService already takes. Exactly
 * the fields of one kind are populated:
 *
 * <ul>
 *   <li>TARGETING_UPDATE - {@code enabled} + {@code config}
 *   <li>KILL_SWITCH - {@code active}
 *   <li>ROLLBACK - {@code toVersion}
 * </ul>
 *
 * <p>Keeping the payload in the service's own vocabulary is the point: applying an
 * approved request is the same call the author would have made directly, so it is
 * versioned, audited and rollback-able in exactly the same way.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ChangeRequestPayload(
    Boolean enabled,
    TargetingConfig config,
    Boolean active,
    Integer toVersion) {

    public static ChangeRequestPayload ofTargetingUpdate(boolean enabled, TargetingConfig config) {
        return new ChangeRequestPayload(enabled, config, null, null);
    }

    public static ChangeRequestPayload ofKillSwitch(boolean active) {
        return new ChangeRequestPayload(null, null, active, null);
    }

    public static ChangeRequestPayload ofRollback(int toVersion) {
        return new ChangeRequestPayload(null, null, null, toVersion);
    }
}
