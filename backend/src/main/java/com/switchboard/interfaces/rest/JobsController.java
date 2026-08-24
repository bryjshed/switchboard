package com.switchboard.interfaces.rest;

import com.switchboard.application.ai.JobResult;
import com.switchboard.application.ai.PartitionMaintenanceService;
import com.switchboard.application.ai.RolloutMonitorService;
import com.switchboard.application.ai.StaleFlagService;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.interfaces.rest.api.JobsApi;
import com.switchboard.interfaces.rest.model.JobRunResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * Job triggers. These endpoints are outside the bearer-token chain (Cloud
 * Scheduler has no user), so the shared secret in {@code X-Job-Token} is the
 * whole authentication story. An unset {@code switchboard.jobs.token} refuses
 * every call rather than accepting an empty header - failing closed matters more
 * here than convenience, because these endpoints mutate flags.
 */
@RestController
public class JobsController implements JobsApi {

    private final String jobToken;
    private final RolloutMonitorService monitor;
    private final StaleFlagService staleFlags;
    private final PartitionMaintenanceService partitions;

    public JobsController(
        @Value("${switchboard.jobs.token:}") String jobToken,
        RolloutMonitorService monitor,
        StaleFlagService staleFlags,
        PartitionMaintenanceService partitions) {
        this.jobToken = jobToken;
        this.monitor = monitor;
        this.staleFlags = staleFlags;
        this.partitions = partitions;
    }

    @Override
    public Mono<ResponseEntity<JobRunResponse>> runRolloutScan(
        String xJobToken, ServerWebExchange exchange) {
        return authorize(xJobToken).then(Mono.defer(monitor::scan)).map(JobsController::toResponse);
    }

    @Override
    public Mono<ResponseEntity<JobRunResponse>> runStaleFlagScan(
        String xJobToken, ServerWebExchange exchange) {
        return authorize(xJobToken).then(Mono.defer(staleFlags::scan)).map(JobsController::toResponse);
    }

    @Override
    public Mono<ResponseEntity<JobRunResponse>> runPartitionRoll(
        String xJobToken, ServerWebExchange exchange) {
        return authorize(xJobToken).then(Mono.defer(partitions::run)).map(JobsController::toResponse);
    }

    private Mono<Void> authorize(String presented) {
        if (jobToken == null || jobToken.isBlank() || !constantTimeEquals(jobToken, presented)) {
            return Mono.error(new ForbiddenException("Invalid job token"));
        }
        return Mono.empty();
    }

    private static boolean constantTimeEquals(String expected, String presented) {
        if (presented == null) {
            return false;
        }
        return MessageDigest.isEqual(
            expected.getBytes(StandardCharsets.UTF_8), presented.getBytes(StandardCharsets.UTF_8));
    }

    private static ResponseEntity<JobRunResponse> toResponse(JobResult result) {
        return ResponseEntity.ok(
            new JobRunResponse(result.job(), result.itemsScanned(), result.findingsCreated())
                .detail(result.detail()));
    }
}
