package com.switchboard.application.stream;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

/**
 * In-process fan-out of flag changes to SSE subscribers, one multicast sink per
 * environment. Emissions carry the changed flag key; publishes with no live sink
 * are dropped (subscribers always receive a fresh full put on connect).
 */
@Component
public class EnvironmentStreamHub {

    private final Map<UUID, Sinks.Many<String>> sinks = new ConcurrentHashMap<>();

    public void publish(UUID environmentId, String flagKey) {
        Sinks.Many<String> sink = sinks.get(environmentId);
        if (sink != null) {
            sink.tryEmitNext(flagKey);
        }
    }

    public Flux<String> subscribe(UUID environmentId) {
        return sinks.computeIfAbsent(environmentId,
                id -> Sinks.many().multicast().onBackpressureBuffer(256, false))
            .asFlux();
    }

    /** Live SSE subscribers across every environment. Gauged; see MetricsConfig. */
    public int subscriberCount() {
        return sinks.values().stream().mapToInt(Sinks.Many::currentSubscriberCount).sum();
    }

    /**
     * Environments holding a sink. Sinks are never removed, so this only grows - it is gauged
     * alongside {@link #subscriberCount()} precisely so the gap between the two is visible.
     */
    public int trackedEnvironmentCount() {
        return sinks.size();
    }
}
