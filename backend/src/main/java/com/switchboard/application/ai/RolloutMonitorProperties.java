package com.switchboard.application.ai;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Everything the rollout monitor decides with. All of it was {@code private static final} before,
 * so none of it could be tuned without a rebuild.
 *
 * <p><b>The property worth understanding is that {@code scan-interval} does not appear in any
 * decision.</b> Set it to a minute or to a day and the error guarantees are unchanged, because the
 * statistic underneath is anytime-valid. That is the entire difference from the predecessor, where
 * scanning more often meant more false rollbacks and nothing said so.
 *
 * <p>{@code tau} is the one to be careful with, and the care needed is counter-intuitive: it must
 * be set from what you consider worth reacting to, never fitted to what the data is doing. Validity
 * does not depend on it - only power does - and making it a function of the sample destroys the
 * supermartingale property that the whole design rests on, silently.
 */
@ConfigurationProperties(prefix = "switchboard.rollout-monitor")
public class RolloutMonitorProperties {

    private boolean enabled = true;

    /**
     * Distinct subjects per arm before a comparison is attempted. Subjects, not evaluation events.
     *
     * <p>This is a normal-approximation guard, not error control - the e-value is valid at any
     * sample size, but the Gaussian mixture it is built on is a poor approximation in the low
     * tens. Raising it costs sensitivity on small canaries and buys nothing statistically.
     */
    private long minSubjects = 200;

    /**
     * Ceiling on how far back an epoch's evidence window may reach.
     *
     * <p>The event tables keep four months of partitions, so an unbounded window would eventually
     * query partitions that no longer exist. When this binds, the martingale restarts at a clock
     * time rather than a data-dependent one - which is still legitimate, because a restart on a
     * fixed calendar is independent of the outcomes, but it weakens the guarantee from "at most
     * alpha forever" to "at most alpha per window". Findings record that it happened.
     */
    private Duration maxLookback = Duration.ofDays(30);

    private final Metrics metrics = new Metrics();
    private final Alpha alpha = new Alpha();
    private final Tau tau = new Tau();
    private final Srm srm = new Srm();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public long getMinSubjects() {
        return minSubjects;
    }

    public void setMinSubjects(long minSubjects) {
        this.minSubjects = minSubjects;
    }

    public Duration getMaxLookback() {
        return maxLookback;
    }

    public void setMaxLookback(Duration maxLookback) {
        this.maxLookback = maxLookback;
    }

    public Metrics getMetrics() {
        return metrics;
    }

    public Alpha getAlpha() {
        return alpha;
    }

    public Tau getTau() {
        return tau;
    }

    public Srm getSrm() {
        return srm;
    }

    /** Which metric keys carry the two signals the monitor acts on. */
    public static class Metrics {
        private String errorKey = "error";
        private String conversionKey = "conversion";

        public String getErrorKey() {
            return errorKey;
        }

        public void setErrorKey(String errorKey) {
            this.errorKey = errorKey;
        }

        public String getConversionKey() {
            return conversionKey;
        }

        public void setConversionKey(String conversionKey) {
            this.conversionKey = conversionKey;
        }
    }

    /**
     * False-discovery rates, one per direction.
     *
     * <p>Asymmetric because the costs are. A false rollback reverts to a known-good baseline, is
     * fully audited, and is cheap to undo. A false ramp pushes a worse variant onto more traffic
     * and locks in the next rung of the ladder. Tolerate more of the former.
     */
    public static class Alpha {
        private double heal = 0.05;
        private double optimize = 0.01;
        private double srm = 0.001;

        public double getHeal() {
            return heal;
        }

        public void setHeal(double heal) {
            this.heal = heal;
        }

        public double getOptimize() {
            return optimize;
        }

        public void setOptimize(double optimize) {
            this.optimize = optimize;
        }

        public double getSrm() {
            return srm;
        }

        public void setSrm(double srm) {
            this.srm = srm;
        }
    }

    /**
     * Mixture scales, as absolute differences in proportion.
     *
     * <p>A one-point absolute rise in error rate is worth an automated rollback; a two-point
     * absolute lift in conversion is worth a ramp. Smaller values detect smaller effects but take
     * longer to reach any given level of evidence.
     */
    public static class Tau {
        private double error = 0.01;
        private double conversion = 0.02;

        public double getError() {
            return error;
        }

        public void setError(double error) {
            this.error = error;
        }

        public double getConversion() {
            return conversion;
        }

        public void setConversion(double conversion) {
            this.conversion = conversion;
        }
    }

    /** The sample-ratio-mismatch gate. */
    public static class Srm {
        private boolean enabled = true;

        /**
         * Below this many rollout-served subjects in total, the gate does not run.
         *
         * <p>Firing suppresses every comparison for the flag, so it is too blunt an instrument to
         * trigger on the noise of a handful of subjects.
         */
        private long minSubjects = 500;

        /**
         * Dirichlet concentration. Selects which size of mismatch the gate is most powerful
         * against; 1.0 is weakly informative and strongest against gross breakage, which is what
         * this gate is for.
         */
        private double concentration = 1.0;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public long getMinSubjects() {
            return minSubjects;
        }

        public void setMinSubjects(long minSubjects) {
            this.minSubjects = minSubjects;
        }

        public double getConcentration() {
            return concentration;
        }

        public void setConcentration(double concentration) {
            this.concentration = concentration;
        }
    }
}
