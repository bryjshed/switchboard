package com.switchboard.application.ai;

import com.switchboard.application.webhook.WebhookDispatcher;
import com.switchboard.application.webhook.WebhookEvent;
import com.switchboard.domain.webhook.WebhookEventType;
import java.util.UUID;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Outbound notification for monitor findings.
 *
 * <p>This used to be the whole webhook story: one unsigned URL per org in {@code app_settings},
 * no retries, no filtering, and only ever rollout findings. It is now a thin adapter onto the
 * general {@link WebhookDispatcher}, so a finding is signed, retried and filterable exactly
 * like a flag change - and there is one delivery path to reason about rather than two.
 * V8 migrates any URL configured under the old setting into a real webhook row, so orgs that
 * had one keep receiving notifications.
 *
 * <p>It is kept as its own type rather than inlined at the three call sites because the
 * monitor should not have to know how an event is shaped, and because a webhook that is
 * unset, slow, or broken must never fail a scan - that guarantee lives here.
 */
@Component
public class NotificationWebhook {

    private final WebhookDispatcher dispatcher;

    public NotificationWebhook(WebhookDispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    /**
     * Raises a {@code rollout.finding}. Errors are swallowed: by the time this runs the
     * finding is already persisted, so failing the scan would lose the scan rather than save
     * the notification.
     */
    @SuppressWarnings("checkstyle:ParameterNumber")
    public Mono<Void> notify(UUID orgId, UUID projectId, UUID environmentId,
        String kind, String flagKey, String envKey, String summary) {

        WebhookEvent event = WebhookEvent.of(
            WebhookEventType.ROLLOUT_FINDING, orgId, projectId, environmentId,
            null, envKey, flagKey, null, "switchboard-monitor",
            // The kind (anomaly / optimization / srm) rides in the summary rather than
            // becoming its own event type: all three are the monitor saying "look at this",
            // and a consumer that wants to split them has the text and the finding record.
            kind + ": " + summary);

        return dispatcher.enqueue(event)
            .doOnNext(dispatcher::deliverNow)
            .onErrorResume(e -> Mono.empty())
            .then();
    }
}
