package com.switchboard.application.audit;

import com.switchboard.application.ai.JobResult;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Prunes {@code audit_entries} past a configured window.
 *
 * <h2>The default is OFF, and that is the opposite of the event tables</h2>
 *
 * <p>{@code switchboard.events.retention-months} defaults to 3 because event rows are telemetry:
 * high-volume, individually meaningless, and expiring them is housekeeping. Audit rows are the
 * opposite - low-volume, individually meaningful, and frequently the thing a compliance review
 * or an incident post-mortem actually needs. A product that silently deleted them after three
 * months because that was a convenient default would be destroying the record its own governance
 * features exist to produce.
 *
 * <p>So {@code switchboard.audit.retention-months} defaults to <b>0, meaning keep forever</b>. An
 * operator who wants a retention window - because a data-protection policy requires one, which is
 * the usual reason - sets it deliberately. That makes deletion an act with an owner rather than a
 * default nobody chose.
 *
 * <h2>It deletes in batches, unlike the event roll</h2>
 *
 * <p>Event retention drops whole partitions, which is an unlink and effectively free. This table
 * is not partitioned, so pruning is a row-wise {@code DELETE} whose cost is proportional to the
 * rows removed. One unbounded statement over a long-neglected table would hold locks and bloat
 * the WAL for as long as it ran, so it deletes in bounded batches and reports how many it took.
 * Whatever it does not reach this run, it reaches next run.
 */
@Service
public class AuditRetentionService {

    private static final Logger log = LoggerFactory.getLogger(AuditRetentionService.class);

    /** Rows per statement. Small enough to keep each delete short, large enough to make progress. */
    private static final int BATCH_SIZE = 5_000;

    /** Batches per run, so one invocation cannot run unboundedly on a huge backlog. */
    private static final int MAX_BATCHES = 40;

    private final DatabaseClient db;
    private final int retentionMonths;

    public AuditRetentionService(
        DatabaseClient db,
        @Value("${switchboard.audit.retention-months:0}") int retentionMonths) {
        this.db = db;
        // Negative is meaningless and would compute a cutoff in the future - i.e. delete
        // everything. Clamped to "keep forever" rather than trusted.
        this.retentionMonths = Math.max(0, retentionMonths);
    }

    public Mono<JobResult> run() {
        if (retentionMonths == 0) {
            return Mono.just(new JobResult("audit-retention", 0, 0,
                "disabled (switchboard.audit.retention-months=0, keep forever)"));
        }
        Instant cutoff = LocalDate.now(ZoneOffset.UTC)
            .withDayOfMonth(1)
            .minusMonths(retentionMonths)
            .atStartOfDay(ZoneOffset.UTC)
            .toInstant();

        return deleteBatches(cutoff, 0, 0)
            .map(deleted -> new JobResult("audit-retention", (int) Math.min(deleted, Integer.MAX_VALUE), 0,
                "deleted=" + deleted + " older than " + cutoff + " (retentionMonths=" + retentionMonths + ")"));
    }

    /**
     * Deletes up to {@link #MAX_BATCHES} batches, stopping early when a batch removes nothing.
     *
     * <p>Recursive rather than a loop because each step is a separate round trip and this is a
     * reactive stack; {@code expand} would read no better for a bounded count.
     */
    private Mono<Long> deleteBatches(Instant cutoff, int batch, long removedSoFar) {
        if (batch >= MAX_BATCHES) {
            log.info("Audit retention stopped at the batch ceiling with {} removed; more remains", removedSoFar);
            return Mono.just(removedSoFar);
        }
        return db.sql("""
                DELETE FROM audit_entries
                WHERE id IN (
                    SELECT id FROM audit_entries WHERE created_at < :cutoff LIMIT :batchSize
                )
                """)
            .bind("cutoff", cutoff)
            .bind("batchSize", BATCH_SIZE)
            .fetch()
            .rowsUpdated()
            .flatMap(removed -> removed == 0
                ? Mono.just(removedSoFar)
                : deleteBatches(cutoff, batch + 1, removedSoFar + removed));
    }

    /** Exposed so the export endpoint can tell a caller how far back the record actually goes. */
    public int retentionMonths() {
        return retentionMonths;
    }
}
