package com.switchboard.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.EvalOutcome;
import com.switchboard.domain.evaluation.EvalReason;
import com.switchboard.domain.evaluation.FlagEvaluator;
import com.switchboard.sdk.internal.BootstrapCodec;
import com.switchboard.sdk.internal.Transport;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Holds an environment's rule set in memory and evaluates flags in process.
 *
 * <p>Usable directly, and used by {@link SwitchboardProvider} for callers who want
 * OpenFeature. Every flag check is a map lookup plus a hash - no I/O, so it costs nothing on
 * the hot path and keeps working while Switchboard is unreachable.
 *
 * <pre>{@code
 * try (var client = new SwitchboardClient(SwitchboardConfig.builder(key).build())) {
 *     client.start();
 *     boolean on = client.booleanValue("new-checkout", false, EvalContexts.of("user-3"));
 * }
 * }</pre>
 *
 * <h2>It serves defaults rather than throwing</h2>
 *
 * <p>Every evaluation returns a value. An unknown flag, an unparseable variation, a client
 * that has not loaded yet - all serve the caller's default and report the reason, because a
 * flag system that can take an application down when it does not recognise a key is worse
 * than no flag system. That is the same rule the server follows in returning HTTP 200 with
 * {@code SDK_DEFAULT} for an unknown flag.
 *
 * <p>The evaluation itself is {@link FlagEvaluator}, the exact class the server runs. This
 * SDK cannot disagree with the server about bucketing, operators or precedence, because
 * there is no second implementation to disagree with.
 */
public final class SwitchboardClient implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(SwitchboardClient.class);
    private static final String TRUE = "true";
    private static final String FALSE = "false";

    private final SwitchboardConfig config;
    private final Transport transport;

    private final AtomicReference<BootstrapCodec.Snapshot> snapshot =
        new AtomicReference<>(BootstrapCodec.Snapshot.empty());
    private final AtomicReference<String> etag = new AtomicReference<>();
    private final AtomicReference<Instant> lastUpdate = new AtomicReference<>();
    private final AtomicBoolean ready = new AtomicBoolean(false);
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final CountDownLatch firstPayload = new CountDownLatch(1);

    private volatile Thread worker;

    public SwitchboardClient(SwitchboardConfig config) {
        this.config = config;
        this.transport = new Transport(config.baseUri(), config.sdkKey(), config.requestTimeout());
    }

    /**
     * Fetches the first payload and starts keeping it fresh.
     *
     * <p>Blocks up to {@link SwitchboardConfig.Builder#startTimeout}. Returning without a
     * payload is not an error by default - see
     * {@link SwitchboardConfig.Builder#failFastOnStart}.
     */
    public void start() {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        refreshOnce();
        Thread t = Thread.ofVirtual().name("switchboard-sdk").unstarted(this::runUpdates);
        this.worker = t;
        t.start();
        try {
            firstPayload.await(config.startTimeout().toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (!ready.get()) {
            String message = "Switchboard: no flag configuration after " + config.startTimeout()
                + "; serving caller defaults until a payload arrives.";
            if (config.failFastOnStart()) {
                throw new IllegalStateException(message);
            }
            log.warn(message);
        }
    }

    /** True once a payload has been loaded. A health check should surface this. */
    public boolean isReady() {
        return ready.get();
    }

    /**
     * True when the configuration may be out of date - no stream traffic for longer than
     * {@code staleAfter}. Evaluation keeps working; this is for observability, since silently
     * serving stale flags is the failure mode nobody notices.
     */
    public boolean isStale() {
        Duration limit = config.staleAfter();
        Instant seen = lastUpdate.get();
        if (limit.isZero() || limit.isNegative() || seen == null) {
            return false;
        }
        return Instant.now().isAfter(seen.plus(limit));
    }

    /** The environment stateVersion currently held. */
    public long stateVersion() {
        return snapshot.get().stateVersion();
    }

    // ------------------------------------------------------------------ evaluation

    /** The raw variation value as a string, which is how every value travels on the wire. */
    public EvaluationDetail<String> stringValue(String flagKey, String fallback, EvalContext context) {
        return evaluate(flagKey, fallback, context);
    }

    /** Parses the variation value as {@code "true"} / {@code "false"}. */
    public EvaluationDetail<Boolean> booleanValue(String flagKey, boolean fallback, EvalContext context) {
        EvaluationDetail<String> raw = evaluate(flagKey, fallback ? TRUE : FALSE, context);
        if (raw.isError()) {
            return retype(raw, fallback);
        }
        if (TRUE.equals(raw.value())) {
            return retype(raw, true);
        }
        if (FALSE.equals(raw.value())) {
            return retype(raw, false);
        }
        return EvaluationDetail.error(fallback, EvaluationDetail.ErrorKind.PARSE_ERROR,
            "\"" + raw.value() + "\" is not \"true\" or \"false\"");
    }

    /** Parses the variation value as a double. */
    public EvaluationDetail<Double> doubleValue(String flagKey, double fallback, EvalContext context) {
        EvaluationDetail<String> raw = evaluate(flagKey, Double.toString(fallback), context);
        if (raw.isError()) {
            return retype(raw, fallback);
        }
        try {
            double parsed = Double.parseDouble(raw.value().trim());
            if (!Double.isFinite(parsed)) {
                throw new NumberFormatException("not finite");
            }
            return retype(raw, parsed);
        } catch (NumberFormatException e) {
            return EvaluationDetail.error(fallback, EvaluationDetail.ErrorKind.PARSE_ERROR,
                "\"" + raw.value() + "\" is not a finite number");
        }
    }

    /** Parses the variation value as an integer. */
    public EvaluationDetail<Integer> integerValue(String flagKey, int fallback, EvalContext context) {
        EvaluationDetail<Double> parsed = doubleValue(flagKey, fallback, context);
        if (parsed.isError()) {
            return retype(parsed, fallback);
        }
        return retype(parsed, (int) Math.round(parsed.value()));
    }

    /** Parses the variation value as JSON. */
    public EvaluationDetail<JsonNode> jsonValue(String flagKey, JsonNode fallback, EvalContext context) {
        EvaluationDetail<String> raw = evaluate(flagKey, null, context);
        if (raw.isError() || raw.value() == null) {
            return retype(raw, fallback);
        }
        try {
            return retype(raw, Transport.json().readTree(raw.value()));
        } catch (Exception e) {
            return EvaluationDetail.error(fallback, EvaluationDetail.ErrorKind.PARSE_ERROR,
                "value is not valid JSON: " + e.getMessage());
        }
    }

    /**
     * The core evaluation. Everything typed above funnels through here, so there is exactly
     * one place where precedence, readiness and the fail-safe are decided.
     */
    public EvaluationDetail<String> evaluate(String flagKey, String fallback, EvalContext context) {
        if (context == null || context.key() == null || context.key().isBlank()) {
            return EvaluationDetail.error(fallback, EvaluationDetail.ErrorKind.INVALID_CONTEXT,
                "the evaluation context has no key to bucket on");
        }
        BootstrapCodec.Snapshot current = snapshot.get();
        if (!ready.get()) {
            return EvaluationDetail.error(fallback, EvaluationDetail.ErrorKind.CLIENT_NOT_READY,
                "no flag configuration loaded yet");
        }
        BootstrapCodec.Entry entry = current.flagsByKey().get(flagKey);
        if (entry == null) {
            // Deliberately indistinguishable from a flag hidden from this key: absent, not
            // forbidden. Same rule as the server's 200 + SDK_DEFAULT.
            return EvaluationDetail.error(fallback, EvaluationDetail.ErrorKind.FLAG_NOT_FOUND,
                "no flag \"" + flagKey + "\" in environment " + current.envKey());
        }
        EvalOutcome outcome = FlagEvaluator.evaluate(
            entry.flag(), entry.config(), context, current.segmentsByKey());
        if (outcome.value() == null) {
            return EvaluationDetail.error(fallback, EvaluationDetail.ErrorKind.PARSE_ERROR,
                "the flag resolved to a variation that no longer exists");
        }
        return EvaluationDetail.of(outcome.value(), outcome.reason(), outcome.variationId(), outcome.ruleId());
    }

    /** Every flag in the environment evaluated for one context. */
    public Map<String, EvaluationDetail<String>> allFlags(EvalContext context) {
        Map<String, EvaluationDetail<String>> out = new LinkedHashMap<>();
        for (String key : snapshot.get().flagsByKey().keySet()) {
            out.put(key, evaluate(key, null, context));
        }
        return Map.copyOf(out);
    }

    @SuppressWarnings("unchecked")
    private static <A, B> EvaluationDetail<B> retype(EvaluationDetail<A> from, B value) {
        return new EvaluationDetail<>(value, from.reason(), from.variationId(), from.ruleId(),
            from.errorKind(), from.errorMessage());
    }

    // ------------------------------------------------------------------ freshness

    /** One conditional fetch. Failure leaves whatever snapshot is already held in place. */
    private void refreshOnce() {
        Transport.BootstrapResult result = transport.fetchBootstrap(etag.get());
        switch (result) {
            case Transport.BootstrapResult.Fresh fresh -> {
                apply(fresh.body());
                etag.set(fresh.etag());
            }
            case Transport.BootstrapResult.NotModified ignored -> lastUpdate.set(Instant.now());
            case Transport.BootstrapResult.Failed failed -> log.warn(
                "Switchboard: bootstrap failed ({}), continuing with the configuration already held: {}",
                failed.status(), failed.message());
        }
    }

    private void apply(JsonNode body) {
        try {
            snapshot.set(BootstrapCodec.readBootstrap(body));
            lastUpdate.set(Instant.now());
            if (ready.compareAndSet(false, true)) {
                firstPayload.countDown();
            }
        } catch (RuntimeException e) {
            // An unreadable payload must not replace a readable one, and must not throw on
            // the caller's thread. Keep serving what we have and say so.
            log.warn("Switchboard: could not read the flag payload, keeping the previous one: {}", e.toString());
        }
    }

    private void runUpdates() {
        int failures = 0;
        while (running.get() && !Thread.currentThread().isInterrupted()) {
            try {
                if (config.mode() == SwitchboardConfig.UpdateMode.STREAMING) {
                    transport.streamChanges(Long.toString(stateVersion()), this::onStreamEvent);
                    // A clean return means the server closed the stream; reconnect.
                    failures = 0;
                } else {
                    Thread.sleep(config.pollInterval().toMillis());
                    refreshOnce();
                    continue;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception e) {
                failures++;
                log.debug("Switchboard: update channel dropped ({}), reconnecting", e.toString());
            }
            if (!running.get()) {
                return;
            }
            try {
                Thread.sleep(backoffMillis(failures));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            // Every reconnect re-reads the bootstrap. A stream that was down may have missed
            // a change, and the conditional GET makes catching up nearly free when it did not.
            refreshOnce();
        }
    }

    private void onStreamEvent(Transport.SseEvent event) {
        lastUpdate.set(Instant.now());
        switch (event.event()) {
            case "put" -> apply(readTree(event.data()));
            case "patch" -> applyPatch(readTree(event.data()));
            default -> { /* ping, and anything added later */ }
        }
    }

    /** A single flag changed. Replaces just that entry rather than refetching everything. */
    private void applyPatch(JsonNode node) {
        if (node == null || !node.isObject()) {
            return;
        }
        try {
            BootstrapCodec.Entry entry = BootstrapCodec.readFlag(node);
            snapshot.updateAndGet(current -> {
                Map<String, BootstrapCodec.Entry> flags = new LinkedHashMap<>(current.flagsByKey());
                flags.put(entry.flag().key(), entry);
                long version = Math.max(current.stateVersion(), node.path("stateVersion").asLong(0L));
                return new BootstrapCodec.Snapshot(current.envKey(), version, Map.copyOf(flags), current.segmentsByKey());
            });
        } catch (RuntimeException e) {
            // A patch we cannot read means our picture may now be wrong; a full refetch is
            // the recovery, not dropping the event on the floor.
            log.debug("Switchboard: unreadable patch, refetching: {}", e.toString());
            refreshOnce();
        }
    }

    private static JsonNode readTree(String data) {
        try {
            return Transport.json().readTree(data);
        } catch (Exception e) {
            return null;
        }
    }

    /** Exponential with a 30s ceiling. Jittered so a fleet does not reconnect in lockstep. */
    private static long backoffMillis(int failures) {
        long base = Math.min(30_000L, 500L * (1L << Math.min(failures, 6)));
        return base / 2 + (long) (Math.random() * base / 2);
    }

    @Override
    public void close() {
        running.set(false);
        Thread t = worker;
        if (t != null) {
            t.interrupt();
        }
    }
}
