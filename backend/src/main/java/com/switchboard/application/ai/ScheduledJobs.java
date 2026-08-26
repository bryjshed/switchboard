package com.switchboard.application.ai;

import com.switchboard.application.webhook.WebhookDispatcher;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Best-effort in-process backstop for the rollout scan.
 *
 * <p>Cloud Scheduler hitting /api/jobs/* is the real trigger in every deployed
 * environment: this service scales to zero, so an instance that is not running
 * cannot fire a timer, and several instances would each fire their own. A
 * @Scheduled-only design would silently stop scanning whenever traffic dried up.
 * This exists so a single always-on instance (local development, a pinned
 * min-instances deployment) still heals without external wiring.
 */
@Component
@ConditionalOnProperty(name = "switchboard.jobs.scheduled-enabled", havingValue = "true", matchIfMissing = true)
public class ScheduledJobs {

    private static final Logger log = LoggerFactory.getLogger(ScheduledJobs.class);

    private final RolloutMonitorService monitor;
    private final WebhookDispatcher webhooks;

    public ScheduledJobs(RolloutMonitorService monitor, WebhookDispatcher webhooks) {
        this.monitor = monitor;
        this.webhooks = webhooks;
    }

    @Scheduled(fixedRateString = "PT1H", initialDelayString = "PT5M")
    public void hourlyRolloutScan() {
        monitor.scan()
            .doOnNext(result -> log.info("Scheduled rollout scan: scanned={} findings={}",
                result.itemsScanned(), result.findingsCreated()))
            .doOnError(e -> log.warn("Scheduled rollout scan failed: {}", e.toString()))
            .onErrorResume(e -> reactor.core.publisher.Mono.empty())
            .subscribe();
    }

    /**
     * Retries webhook deliveries that are due.
     *
     * <p>Runs far more often than the rollout scan because the first backoff step is 30
     * seconds and a receiver that was restarting should not wait an hour to hear about a kill
     * switch. The same caveat as above applies - an instance that is not running cannot fire a
     * timer - so /api/jobs/webhook-sweep exists for external scheduling. A sweep is idempotent
     * and bounded by a batch size, so overlapping triggers are safe.
     */
    @Scheduled(fixedRateString = "PT30S", initialDelayString = "PT30S")
    public void webhookSweep() {
        webhooks.sweep()
            .doOnNext(attempted -> {
                if (attempted > 0) {
                    log.info("Webhook sweep attempted {} deliveries", attempted);
                }
            })
            .doOnError(e -> log.warn("Webhook sweep failed: {}", e.toString()))
            .onErrorResume(e -> reactor.core.publisher.Mono.empty())
            .subscribe();
    }
}
