package com.switchboard.application.evaluation;

import com.switchboard.domain.flag.FlagAndConfig;
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
}
