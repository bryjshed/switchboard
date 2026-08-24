package com.switchboard.application.ai;

import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.ai.AnomalyFinding;
import com.switchboard.domain.ai.AnomalyFindingRepository;
import com.switchboard.domain.ai.AnomalyStatus;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import java.util.UUID;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Listing and acknowledging rollout-monitor findings. */
@Service
public class AnomalyService {

    private final AnomalyFindingRepository findings;
    private final OrgAccessService access;

    public AnomalyService(AnomalyFindingRepository findings, OrgAccessService access) {
        this.findings = findings;
        this.access = access;
    }

    public Flux<AnomalyFinding> list(UUID environmentId, UUID userId, AnomalyStatus status) {
        return access.requireEnvironmentMember(environmentId, userId)
            .thenMany(Flux.defer(() -> findings.listByEnvironment(environmentId, status)));
    }

    public Mono<AnomalyFinding> acknowledge(UUID anomalyId, UUID userId) {
        return findings.findById(anomalyId)
            .switchIfEmpty(Mono.error(new NotFoundException("Anomaly finding not found")))
            .flatMap(finding -> access.requireEnvironmentMember(finding.environmentId(), userId)
                .then(findings.acknowledge(anomalyId))
                .switchIfEmpty(Mono.error(new ConflictException(
                    "Finding is not OPEN (current status " + finding.status() + ")"))));
    }
}
