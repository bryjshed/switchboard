package com.switchboard.interfaces.security;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * A token bucket per credential, so a runaway client gets a 429 instead of the database.
 *
 * <p>OFREP has always documented a {@code Retry-After} path, and until now nothing in Switchboard
 * could produce one: there was no limiter anywhere. A documented recovery path that can never fire
 * is worse than none, because a client implements it and never finds out it does not work.
 *
 * <h2>Where it sits</h2>
 *
 * <p><b>Before authentication</b>, deliberately. Resolving a credential costs a database round trip
 * on a miss, so a limiter that ran after auth would let an attacker spray invented keys through the
 * expensive path at full rate - the very thing the SDK-key negative cache exists to bound. Running
 * first means the cheap check happens first.
 *
 * <p>That means the bucket is keyed on the raw credential rather than on a resolved principal: a
 * hash of the Authorization header, or the remote address when there is none. Hashed because these
 * are live credentials and this class holds them in memory for minutes.
 *
 * <h2>What it is not</h2>
 *
 * <p><b>Per instance.</b> Two instances mean two buckets and therefore twice the configured rate.
 * That is honest rather than ideal, and it is the first thing in the system that genuinely needs a
 * shared store - see {@code docs/DECISIONS.md} on when Redis earns its place. The limits are set
 * high enough that per-instance drift does not matter for the abuse this is meant to stop.
 *
 * <p>It deliberately does not use the {@code CacheRegistry} seam either: that seam is a read-through
 * cache for values that can be recomputed, and a rate-limit bucket is mutable state that must not be
 * recomputed. Borrowing it would have meant a loader that lies.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class RateLimitFilter implements WebFilter {

    /** Meter name for refused requests, so a limit that is too tight is visible rather than guessed. */
    public static final String THROTTLED_COUNTER = "switchboard.ratelimit.throttled";

    private final boolean enabled;
    private final int burst;
    private final double refillPerSecond;
    private final Cache<String, Bucket> buckets;
    private final Counter throttled;

    public RateLimitFilter(
        @Value("${switchboard.ratelimit.enabled:true}") boolean enabled,
        @Value("${switchboard.ratelimit.requests-per-minute:6000}") int requestsPerMinute,
        @Value("${switchboard.ratelimit.burst:600}") int burst,
        MeterRegistry meters) {

        this.enabled = enabled;
        this.burst = Math.max(1, burst);
        this.refillPerSecond = Math.max(1, requestsPerMinute) / 60.0;
        this.buckets = Caffeine.newBuilder()
            // Idle buckets are full buckets; forgetting one costs nothing but memory saved.
            .expireAfterAccess(Duration.ofMinutes(10))
            .maximumSize(100_000)
            .build();
        this.throttled = Counter.builder(THROTTLED_COUNTER)
            .description("Requests refused with 429 by the rate limiter")
            .register(meters);
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (!enabled) {
            return chain.filter(exchange);
        }
        // Health and readiness must never be throttled: a limiter that can make a pod look unhealthy
        // under load turns a traffic spike into a restart loop.
        String path = exchange.getRequest().getPath().value();
        if (path.startsWith("/actuator")) {
            return chain.filter(exchange);
        }

        Bucket bucket = buckets.get(identity(exchange.getRequest()), key -> new Bucket(burst));
        if (bucket.tryConsume(refillPerSecond, burst)) {
            return chain.filter(exchange);
        }

        throttled.increment();
        ServerHttpResponse response = exchange.getResponse();
        response.setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
        // Seconds until one token exists again, rounded up and never zero - a Retry-After of 0
        // invites an immediate retry, which is the opposite of what this is asking for.
        response.getHeaders().set(HttpHeaders.RETRY_AFTER, Long.toString(bucket.secondsUntilToken(refillPerSecond)));
        return response.setComplete();
    }

    /**
     * The bucket key: a hash of the credential, or the remote address when unauthenticated.
     *
     * <p>Hashing matters. This map lives in memory for minutes and appears in heap dumps; holding
     * raw SDK keys and personal access tokens there would turn a diagnostic artefact into a
     * credential dump.
     */
    private static String identity(ServerHttpRequest request) {
        String authorization = request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
        if (authorization != null && !authorization.isBlank()) {
            return "c:" + SwitchboardAuthenticationManager.sha256(authorization);
        }
        String apiKey = request.getHeaders().getFirst("X-API-Key");
        if (apiKey != null && !apiKey.isBlank()) {
            return "c:" + SwitchboardAuthenticationManager.sha256(apiKey);
        }
        return "a:" + (request.getRemoteAddress() == null
            ? "unknown"
            : sha256(request.getRemoteAddress().getAddress().getHostAddress()));
    }

    private static String sha256(String value) {
        return SwitchboardAuthenticationManager.sha256(value);
    }

    /**
     * A token bucket that refills continuously rather than on a timer.
     *
     * <p>Continuous refill is what makes a burst allowance meaningful: a client that has been idle
     * for a minute may spend its whole burst at once, while one that has been at the limit gets
     * exactly the steady rate. A fixed window would instead let everybody spend a full window's
     * worth at the boundary and then stall - twice the rate at the worst possible moment.
     */
    private static final class Bucket {
        private final AtomicLong state;

        private Bucket(int burst) {
            this.state = new AtomicLong(pack(burst * SCALE, System.nanoTime()));
        }

        /** Tokens are scaled to integers so the whole bucket fits one CAS-able long. */
        private static final long SCALE = 1_000L;
        private static final long MAX_TOKENS = (1L << 20) - 1;

        private static long pack(long tokens, long nanos) {
            return (Math.min(tokens, MAX_TOKENS) << 44) | ((nanos >>> 20) & ((1L << 44) - 1));
        }

        private static long tokensOf(long packed) {
            return packed >>> 44;
        }

        private static long nanosOf(long packed) {
            return (packed & ((1L << 44) - 1)) << 20;
        }

        boolean tryConsume(double refillPerSecond, int burst) {
            for (;;) {
                long current = state.get();
                long now = System.nanoTime();
                long elapsed = Math.max(0, now - nanosOf(current));
                long refilled = (long) (elapsed / 1e9 * refillPerSecond * SCALE);
                long tokens = Math.min(tokensOf(current) + refilled, (long) burst * SCALE);
                if (tokens < SCALE) {
                    return false;
                }
                if (state.compareAndSet(current, pack(tokens - SCALE, now))) {
                    return true;
                }
            }
        }

        long secondsUntilToken(double refillPerSecond) {
            long tokens = tokensOf(state.get());
            long needed = SCALE - tokens;
            return Math.max(1, (long) Math.ceil(needed / (refillPerSecond * SCALE)));
        }
    }
}
