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

    private SwitchboardConfig(Builder b) {
        this.sdkKey = b.sdkKey;
        this.baseUri = b.baseUri;
        this.mode = b.mode;
        this.pollInterval = b.pollInterval;
        this.startTimeout = b.startTimeout;
        this.requestTimeout = b.requestTimeout;
        this.staleAfter = b.staleAfter;
        this.failFastOnStart = b.failFastOnStart;
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

        public SwitchboardConfig build() {
            return new SwitchboardConfig(this);
        }
    }
}
