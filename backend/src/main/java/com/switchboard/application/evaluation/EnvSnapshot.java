package com.switchboard.application.evaluation;

import com.switchboard.domain.flag.FlagAndConfig;
import com.switchboard.domain.project.SdkKeyKind;
import com.switchboard.domain.segment.Segment;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Everything needed to evaluate any flag of one environment, loaded atomically. */
public record EnvSnapshot(
    UUID environmentId,
    String envKey,
    long stateVersion,
    List<FlagAndConfig> flags,
    Map<String, Segment> segmentsByKey) {

    public EnvSnapshot {
        flags = flags == null ? List.of() : List.copyOf(flags);
        segmentsByKey = segmentsByKey == null ? Map.of() : Map.copyOf(segmentsByKey);
    }

    /**
     * The same snapshot with only the flags this key kind may see.
     *
     * <p>Segments are left in place: they are needed to evaluate the visible flags, and they never
     * leave the server for a public key - a client payload carries evaluated values, not rules.
     */
    public EnvSnapshot visibleTo(SdkKeyKind kind) {
        List<FlagAndConfig> visible = ClientVisibility.visibleTo(kind, flags);
        return visible.size() == flags.size()
            ? this
            : new EnvSnapshot(environmentId, envKey, stateVersion, visible, segmentsByKey);
    }
}
