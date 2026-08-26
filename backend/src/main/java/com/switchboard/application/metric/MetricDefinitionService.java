package com.switchboard.application.metric;

import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.access.Permission;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.metric.MetricDefinition;
import com.switchboard.domain.metric.MetricDefinitionRepository;
import com.switchboard.domain.metric.MetricDirection;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * User-defined metrics for the rollout monitor.
 *
 * <p>Guarded by {@link Permission#MANAGE_SETTINGS} rather than a flag permission: defining what
 * "worse" means for a project decides when automated rollbacks fire, which is a policy decision
 * about the project rather than an edit to any one flag.
 */
@Service
public class MetricDefinitionService {

    /** The same shape a flag key has, and for the same reason: it travels in JSON and in URLs. */
    private static final Pattern KEY = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");

    private final MetricDefinitionRepository metrics;
    private final OrgAccessService access;

    public MetricDefinitionService(MetricDefinitionRepository metrics, OrgAccessService access) {
        this.metrics = metrics;
        this.access = access;
    }

    public Flux<MetricDefinition> list(UUID projectId, UUID userId) {
        return access.requireProjectMember(projectId, userId)
            .thenMany(metrics.findByProject(projectId));
    }

    public Mono<MetricDefinition> create(UUID projectId, UUID userId, String key, String name,
        String description, MetricDirection direction, double tau, boolean autoAct) {

        return access.requireProjectPermission(projectId, userId, Permission.MANAGE_SETTINGS)
            .then(Mono.fromCallable(() -> {
                String normalised = key == null ? "" : key.trim().toLowerCase(Locale.ROOT);
                if (!KEY.matcher(normalised).matches()) {
                    throw new ValidationException(
                        "Metric key must be lower-case alphanumeric with . _ or -, up to 64 characters");
                }
                validateTau(tau);
                if (direction == null) {
                    throw new ValidationException("direction is required");
                }
                return new MetricDefinition(null, projectId, normalised, name, description,
                    direction, tau, autoAct, null, null);
            }))
            .flatMap(metrics::create)
            .onErrorMap(DataIntegrityViolationException.class,
                e -> new ConflictException("That metric key is already defined for this project"));
    }

    public Mono<MetricDefinition> update(UUID metricId, UUID userId, String name, String description,
        MetricDirection direction, Double tau, Boolean autoAct) {

        if (tau != null) {
            validateTau(tau);
        }
        return owned(metricId, userId, Permission.MANAGE_SETTINGS)
            .flatMap(existing -> metrics.update(metricId, name, description, direction, tau, autoAct));
    }

    public Mono<Void> delete(UUID metricId, UUID userId) {
        return owned(metricId, userId, Permission.MANAGE_SETTINGS)
            .flatMap(existing -> metrics.delete(metricId));
    }

    /**
     * Resolves the metric and checks standing in ITS project.
     *
     * <p>There is no by-id lookup on the repository on purpose - every read is scoped to a
     * project - so this finds it by scanning the project it claims. The caller supplies only the
     * metric id, so the project comes from the row rather than from the request, which is what
     * stops a caller naming someone else's project.
     */
    private Mono<MetricDefinition> owned(UUID metricId, UUID userId, Permission permission) {
        return metrics.findById(metricId)
            .switchIfEmpty(Mono.error(new NotFoundException("Metric not found")))
            .flatMap(metric -> access.requireProjectPermission(metric.projectId(), userId, permission)
                .thenReturn(metric));
    }

    /**
     * tau is an absolute proportion difference, so it lives strictly inside (0, 1). Zero would
     * make every difference "worth reacting to" and one is not reachable by a proportion
     * difference at all. Checked here as well as by the database constraint because a 400 that
     * says which field is wrong beats a 500 carrying a constraint name.
     */
    private static void validateTau(double tau) {
        if (!(tau > 0) || !(tau < 1)) {
            throw new ValidationException("tau must be greater than 0 and less than 1");
        }
    }
}
