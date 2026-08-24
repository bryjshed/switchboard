package com.switchboard.application.evaluation;

import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.project.EnvironmentRepository;
import com.switchboard.domain.segment.Segment;
import com.switchboard.domain.segment.SegmentRepository;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/** Loads the full evaluation snapshot of one environment (flags + head configs + segments). */
@Service
public class EnvironmentSnapshotService {

    private final EnvironmentRepository environments;
    private final FlagRepository flags;
    private final SegmentRepository segments;

    public EnvironmentSnapshotService(
        EnvironmentRepository environments, FlagRepository flags, SegmentRepository segments) {
        this.environments = environments;
        this.flags = flags;
        this.segments = segments;
    }

    public Mono<EnvSnapshot> load(UUID environmentId) {
        return environments.findById(environmentId)
            .switchIfEmpty(Mono.error(new NotFoundException("Environment not found")))
            .flatMap(env -> flags.findAllForEnvironment(environmentId).collectList()
                .zipWith(segments.findByProject(env.projectId()).collectList())
                .map(t -> new EnvSnapshot(
                    env.id(),
                    env.key(),
                    env.stateVersion(),
                    t.getT1(),
                    t.getT2().stream().collect(Collectors.toMap(Segment::key, Function.identity())))));
    }
}
