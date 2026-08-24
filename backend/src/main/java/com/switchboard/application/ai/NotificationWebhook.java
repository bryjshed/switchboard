package com.switchboard.application.ai;

import com.switchboard.application.settings.SettingsService;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.util.retry.Retry;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Best-effort outbound notification for monitor findings. A webhook that is
 * unset, slow, or broken must never fail a scan, so every error is logged and
 * swallowed here rather than propagated.
 */
@Component
public class NotificationWebhook {

    private static final Logger log = LoggerFactory.getLogger(NotificationWebhook.class);
    private static final Duration TIMEOUT = Duration.ofSeconds(5);

    private final SettingsService settings;
    private final WebClient webClient;

    public NotificationWebhook(SettingsService settings) {
        this.settings = settings;
        this.webClient = WebClient.create();
    }

    public Mono<Void> notify(UUID orgId, String type, String flagKey, String envKey, String summary) {
        return settings.get("org." + orgId + ".notifications.webhook")
            .filter(url -> !url.isBlank())
            .flatMap(url -> post(url, payload(type, flagKey, envKey, summary)))
            .onErrorResume(e -> {
                log.warn("Notification webhook failed for org {}: {}", orgId, e.toString());
                return Mono.empty();
            })
            .then();
    }

    private Mono<Void> post(String url, Map<String, Object> payload) {
        return webClient.post()
            .uri(url)
            .bodyValue(payload)
            .retrieve()
            .toBodilessEntity()
            .timeout(TIMEOUT)
            .retryWhen(Retry.max(1))
            .then();
    }

    private static Map<String, Object> payload(String type, String flagKey, String envKey, String summary) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", type);
        body.put("flagKey", flagKey);
        body.put("envKey", envKey);
        body.put("summary", summary);
        return body;
    }
}
