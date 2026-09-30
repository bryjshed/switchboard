package com.switchboard.sdk;

import java.net.URI;
import java.time.Duration;

/**
 * How a {@link SwitchboardClient} connects and stays fresh.
 *
 * <p>Built rather than constructed, because most callers set one thing:
 *
 * <pre>{@code
 * var config = SwitchboardConfig.builder(System.getenv("SWITCHBOARD_SDK_KEY")).build();
 * }</pre>
 */
public final class SwitchboardConfig {

    /** How the SDK keeps its in-memory copy of the rule set current. */
    public enum UpdateMode {
        /** SSE on {@code /api/stream}. Changes land in about a second. The default. */
        STREAMING,
        /** Conditional GET on the bootstrap. For networks that will not hold a stream open. */
        POLLING
    }

    private final String sdkKey;
    private final URI baseUri;
    private final UpdateMode mode;
    private final Duration pollInterval;
    private final Duration startTimeout;
    private final Duration requestTimeout;
    private final Duration staleAfter;
    private final boolean failFastOnStart;
    private final Duration flushInterval;
    private final int maxBatchSize;
    private final int maxQueueSize;
    private final boolean telemetryEnabled;

    /**
     * The most events one request may carry: {@code maxItems} on {@code EvalEventBatch} and
     * {@code MetricEventBatch} in the OpenAPI contract. {@link Builder#maxBatchSize} is clamped
     * to it.
     */
    public static final int MAX_BATCH_SIZE = 500;

    private SwitchboardConfig(Builder b) {
        this.sdkKey = b.sdkKey;
        this.baseUri = b.baseUri;
        this.mode = b.mode;
        this.pollInterval = b.pollInterval;
        this.startTimeout = b.startTimeout;
        this.requestTimeout = b.requestTimeout;
        this.staleAfter = b.staleAfter;
        this.failFastOnStart = b.failFastOnStart;
        this.flushInterval = b.flushInterval;
        this.maxBatchSize = b.maxBatchSize;
        this.maxQueueSize = b.maxQueueSize;
        this.telemetryEnabled = b.telemetryEnabled;
    }

    public static Builder builder(String sdkKey) {
        return new Builder(sdkKey);
    }

    public String sdkKey() {
        return sdkKey;
    }

    public URI baseUri() {
        return baseUri;
    }

    public UpdateMode mode() {
        return mode;
    }

    public Duration pollInterval() {
        return pollInterval;
    }

    public Duration startTimeout() {
        return startTimeout;
    }

    public Duration requestTimeout() {
        return requestTimeout;
    }

    public Duration staleAfter() {
        return staleAfter;
    }

    public boolean failFastOnStart() {
        return failFastOnStart;
    }

    public Duration flushInterval() {
        return flushInterval;
    }

    public int maxBatchSize() {
        return maxBatchSize;
    }

    public int maxQueueSize() {
        return maxQueueSize;
    }

    public boolean telemetryEnabled() {
        return telemetryEnabled;
    }

    /** Builder for {@link SwitchboardConfig}. */
    public static final class Builder {
        private final String sdkKey;
        private URI baseUri = URI.create("http://localhost:28080");
        private UpdateMode mode = UpdateMode.STREAMING;
        private Duration pollInterval = Duration.ofSeconds(30);
        private Duration startTimeout = Duration.ofSeconds(5);
        private Duration requestTimeout = Duration.ofSeconds(10);
        private Duration staleAfter = Duration.ofSeconds(60);
        private boolean failFastOnStart;
        private Duration flushInterval = Duration.ofSeconds(10);
        private int maxBatchSize = MAX_BATCH_SIZE;
        private int maxQueueSize = 10_000;
        private boolean telemetryEnabled = true;

        private Builder(String sdkKey) {
            if (sdkKey == null || sdkKey.isBlank()) {
                throw new IllegalArgumentException("sdkKey is required");
            }
            this.sdkKey = sdkKey;
        }

        public Builder baseUri(String uri) {
            this.baseUri = URI.create(uri);
            return this;
        }

        public Builder mode(UpdateMode mode) {
            this.mode = mode;
            return this;
        }

        public Builder pollInterval(Duration d) {
            this.pollInterval = d;
            return this;
        }

        /** How long {@link SwitchboardClient#start()} waits for the first payload. */
        public Builder startTimeout(Duration d) {
            this.startTimeout = d;
            return this;
        }

        public Builder requestTimeout(Duration d) {
            this.requestTimeout = d;
            return this;
        }

        /** Marks the snapshot stale after this long with no stream traffic. Zero disables. */
        public Builder staleAfter(Duration d) {
            this.staleAfter = d;
            return this;
        }

        /**
         * Whether {@link SwitchboardClient#start()} throws if the first bootstrap fails.
         *
         * <p>Default false, and the default is the important one. A flag SDK that refuses to
         * start because Switchboard is briefly unreachable has converted a degraded
         * dependency into an outage of the application that depends on it. By default the
         * client starts, serves callers' defaults, keeps retrying in the background, and
         * reports {@code false} from {@link SwitchboardClient#isReady()} so a health check
         * can see the truth. Set this only if serving defaults is genuinely worse than not
         * starting at all.
         */
        public Builder failFastOnStart(boolean failFast) {
            this.failFastOnStart = failFast;
            return this;
        }

        /**
         * Whether the client reports telemetry: an evaluation (exposure) event per flag check,
         * and the metrics passed to {@link SwitchboardClient#track}. Default true. Both are the
         * input to Switchboard's heal and optimize loops, so turning this off turns those off
         * for this application - including {@code track()}, which becomes a no-op. The same
         * switch as the TypeScript SDK's {@code telemetry.enabled}.
         */
        public Builder telemetryEnabled(boolean enabled) {
            this.telemetryEnabled = enabled;
            return this;
        }

        /**
         * How often telemetry is sent. Default 10s. Metrics also go early once
         * {@link #maxBatchSize} of them are waiting. Zero disables the timer, leaving the early
         * send, {@link SwitchboardClient#flush()} and {@link SwitchboardClient#close()}.
         */
        public Builder flushInterval(Duration d) {
            if (d == null || d.isNegative()) {
                throw new IllegalArgumentException("flushInterval must be zero or positive");
            }
            this.flushInterval = d;
            return this;
        }

        /** Most events per request. Default 500, clamped to 1..{@value SwitchboardConfig#MAX_BATCH_SIZE}. */
        public Builder maxBatchSize(int size) {
            this.maxBatchSize = Math.max(1, Math.min(size, MAX_BATCH_SIZE));
            return this;
        }

        /**
         * Most events held in memory, per queue (evaluations and metrics). Default 10,000. Past
         * it the OLDEST are dropped and counted, so an unreachable server can never turn into an
         * out-of-memory kill.
         */
        public Builder maxQueueSize(int size) {
            this.maxQueueSize = Math.max(1, size);
            return this;
        }

        public SwitchboardConfig build() {
            return new SwitchboardConfig(this);
        }
    }
}
