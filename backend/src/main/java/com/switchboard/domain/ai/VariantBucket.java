package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.List;

/** One hourly slice of rollout telemetry. */
public record VariantBucket(Instant bucketStart, List<VariantAggregate> variants) {

    public VariantBucket {
        variants = variants == null ? List.of() : List.copyOf(variants);
    }
}
