package com.switchboard.application.ai;

import com.switchboard.domain.ai.EpochEvidenceRepository;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Monthly partition maintenance for the two event tables: create the next two
 * months ahead of time and drop anything older than three months.
 *
 * <p>New partitions are chained onto the upper bound of the newest existing one
 * rather than pinned to UTC midnight. The baseline migration's partitions are
 * not midnight-aligned, and a midnight-aligned month would overlap them and be
 * rejected; chaining keeps whatever alignment a database already has and leaves
 * no gap between months.
 *
 * <p>The DEFAULT catch-all partitions are never dropped - they are what keeps an
 * out-of-range event from being rejected outright, and dropping one would lose
 * every row that landed there.
 *
 * <h2>Retention is configuration</h2>
 *
 * <p>The window is {@code switchboard.events.retention-months} rather than a
 * constant, because the right answer is a property of the deployment and not of
 * the code: it trades disk against how far back the healing loop can look. The
 * floor of one month is not a style choice - the current month's partition is
 * being written to, so a shorter window would drop live data.
 */
@Service
public class PartitionMaintenanceService {

    private static final Logger log = LoggerFactory.getLogger(PartitionMaintenanceService.class);

    private static final List<String> TABLES = List.of("eval_events", "metric_events");
    private static final DateTimeFormatter SUFFIX = DateTimeFormatter.ofPattern("yyyy_MM", Locale.ROOT);
    private static final DateTimeFormatter BOUND =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ssXXX", Locale.ROOT);
    private static final int MAX_CREATES = 24;

    private final DatabaseClient db;
    private final EpochEvidenceRepository evidence;
    private final int monthsAhead;
    private final int monthsRetained;

    public PartitionMaintenanceService(
        DatabaseClient db,
        EpochEvidenceRepository evidence,
        @Value("${switchboard.events.partition-months-ahead:2}") int monthsAhead,
        @Value("${switchboard.events.retention-months:3}") int monthsRetained) {
        this.db = db;
        this.evidence = evidence;
        // At least one month ahead, or the roll job stops being ahead of anything and rows land
        // in the DEFAULT partition on the first of the month.
        this.monthsAhead = Math.max(1, monthsAhead);
        // At least one month retained: the current month's partition is the one being written
        // to, and dropping it would delete live data rather than expire old data.
        this.monthsRetained = Math.max(1, monthsRetained);
    }

    public Mono<JobResult> run() {
        LocalDate currentMonth = LocalDate.now(ZoneOffset.UTC).withDayOfMonth(1);
        // Epoch evidence outlives its rollout by a wide margin, then stops being useful. It is
        // tied to the event window rather than configured separately: evidence about events
        // that have been dropped cannot be recomputed or checked, so keeping it longer than the
        // events would leave a finding whose basis no longer exists.
        Instant evidenceCutoff = currentMonth.minusMonths(monthsRetained)
            .atStartOfDay(ZoneOffset.UTC).toInstant();

        return Flux.fromIterable(TABLES)
            .concatMap(table -> maintain(table, currentMonth))
            .reduce(new int[] {0, 0, 0},
                (acc, counts) -> new int[] {acc[0] + counts[0], acc[1] + counts[1], acc[2] + counts[2]})
            // rollout_epoch_evidence is not partitioned and accumulates one row per hypothesis per
            // epoch forever otherwise. It rides along here because this is already the job whose
            // whole purpose is keeping event-shaped data from growing without bound.
            .flatMap(acc -> evidence.deleteObservedBefore(evidenceCutoff)
                .doOnNext(pruned -> log.info("Pruned {} stale epoch-evidence rows", pruned))
                .onErrorResume(e -> {
                    log.warn("Epoch-evidence prune failed: {}", e.toString());
                    return Mono.just(0L);
                })
                .map(pruned -> new JobResult("partition-roll", acc[0], acc[1],
                    "inspected=" + acc[0] + " created=" + acc[1] + " dropped=" + acc[2]
                        + " evidencePruned=" + pruned)));
    }

    /** Returns {inspected, created, dropped} for one parent table. */
    private Mono<int[]> maintain(String table, LocalDate currentMonth) {
        Instant coverThrough = currentMonth.plusMonths(monthsAhead + 1L)
            .atStartOfDay(ZoneOffset.UTC).toInstant();
        LocalDate cutoff = currentMonth.minusMonths(monthsRetained);

        return Mono.zip(existingPartitions(table), newestUpperBound(table))
            .flatMap(t -> {
                Set<String> before = t.getT1();
                List<String> creates = createStatements(table, t.getT2(), coverThrough, before);
                List<String> drops = before.stream()
                    .filter(name -> isDroppable(table, name, cutoff))
                    .map(name -> "DROP TABLE IF EXISTS " + name)
                    .toList();

                return Flux.fromIterable(creates)
                    .concatMap(sql -> db.sql(sql).then())
                    .thenMany(Flux.fromIterable(drops))
                    .concatMap(sql -> db.sql(sql).then())
                    .then(existingPartitions(table))
                    .map(after -> {
                        long created = after.stream().filter(name -> !before.contains(name)).count();
                        long dropped = before.stream().filter(name -> !after.contains(name)).count();
                        log.info("Partition roll for {}: created={} dropped={}", table, created, dropped);
                        return new int[] {before.size(), (int) created, (int) dropped};
                    });
            });
    }

    /** Months chained forward from {@code from} until coverage reaches {@code coverThrough}. */
    private static List<String> createStatements(
        String table, Instant from, Instant coverThrough, Set<String> existing) {
        List<String> statements = new ArrayList<>();
        OffsetDateTime start = from.atOffset(ZoneOffset.UTC);
        // The bound guards against a pathological gap turning into an endless loop.
        for (int i = 0; i < MAX_CREATES && start.toInstant().isBefore(coverThrough); i++) {
            OffsetDateTime next = start.plusMonths(1);
            String name = table + "_" + start.format(SUFFIX);
            if (!existing.contains(name)) {
                statements.add(createSql(table, name, start, next));
            }
            start = next;
        }
        return statements;
    }

    /**
     * The newest upper bound across the table's real partitions, which is where
     * the next one starts. Postgres does the bound parsing; an unpartitioned or
     * default-only table falls back to the start of the current UTC month.
     */
    private Mono<Instant> newestUpperBound(String table) {
        return db.sql("""
                SELECT max(split_part(
                           split_part(pg_get_expr(c.relpartbound, c.oid), 'TO (''', 2),
                           '''', 1)::timestamptz) AS upper_bound
                FROM pg_inherits i
                JOIN pg_class c ON c.oid = i.inhrelid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = :parent AND c.relname <> :parent || '_default'
                """)
            .bind("parent", table)
            .map(row -> row.get("upper_bound", Instant.class))
            .one()
            .defaultIfEmpty(LocalDate.now(ZoneOffset.UTC).withDayOfMonth(1)
                .atStartOfDay(ZoneOffset.UTC).toInstant());
    }

    private Mono<Set<String>> existingPartitions(String table) {
        return db.sql("""
                SELECT c.relname AS name
                FROM pg_inherits i
                JOIN pg_class c ON c.oid = i.inhrelid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = :parent
                """)
            .bind("parent", table)
            .map(row -> row.get("name", String.class))
            .all()
            .collect(LinkedHashSet::new, Set::add);
    }

    /** Only {@code <table>_YYYY_MM} names older than the cutoff; never {@code <table>_default}. */
    private static boolean isDroppable(String table, String name, LocalDate cutoff) {
        String prefix = table + "_";
        if (!name.startsWith(prefix)) {
            return false;
        }
        String suffix = name.substring(prefix.length());
        if (!suffix.matches("\\d{4}_\\d{2}")) {
            return false;
        }
        LocalDate month = LocalDate.parse(suffix + "_01", DateTimeFormatter.ofPattern("yyyy_MM_dd", Locale.ROOT));
        return month.isBefore(cutoff);
    }

    /**
     * Identifiers cannot be bound, so the SQL is assembled from a fixed table
     * list and a formatted month - no caller-supplied text reaches this string.
     *
     * <p>The create is wrapped the same way the baseline migration wraps its
     * own: a partition that already exists under another name, or whose range
     * an existing partition already covers, both raise here (duplicate_table
     * and invalid_object_definition), and both mean the month is covered. The
     * baseline's partitions are not UTC-midnight aligned, so the overlap case
     * is the normal one on an existing database, not an exotic failure.
     */
    private static String createSql(
        String table, String name, OffsetDateTime from, OffsetDateTime to) {
        return """
            DO $$
            BEGIN
                EXECUTE 'CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (''%s'') '
                     || 'TO (''%s'')';
            EXCEPTION WHEN duplicate_table OR invalid_object_definition THEN
                NULL;
            END $$;
            """.formatted(name, table, BOUND.format(from), BOUND.format(to));
    }
}
