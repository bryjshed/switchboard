package com.switchboard.domain.ai.stats;

/**
 * The e-value Benjamini-Hochberg procedure: false-discovery-rate control over a family of e-values
 * tested together.
 *
 * <h2>Why a correction is needed at all</h2>
 *
 * <p>One scan screens every challenger of every rolling-out flag in an environment, on two metrics.
 * Comparing each against a threshold calibrated for a single hypothesis means the expected number
 * of false findings grows with the number of flags - so the busier the environment, the more
 * spurious rollbacks. The predecessor hid this inside a tie-break: it took the maximum z-score
 * across challengers and tested only that one, which is a maximum of k dependent statistics judged
 * against a one-hypothesis threshold.
 *
 * <h2>Why e-BH rather than p-value BH</h2>
 *
 * <p>Ordinary BH controls FDR under independence or positive dependence. These hypotheses have
 * neither. Within a flag, the error and conversion tests share denominators; across challengers
 * they share the baseline arm; across flags they share {@code metric_events} rows, because a metric
 * event carries no flag key and one conversion is attributed to whatever variation that subject saw
 * of <em>every</em> flag. That last one is structural and cannot be argued away.
 *
 * <p>e-BH controls FDR under <em>arbitrary</em> dependence with no penalty factor. Benjamini-
 * Yekutieli would also be valid but costs a {@code ln(K)} factor in power, which at K in the
 * hundreds is most of the sensitivity the monitor has.
 *
 * <h2>The procedure</h2>
 *
 * <pre>
 *   sort e descending
 *   k* = max { k : e_(k) &gt;= K / (k * alpha) }      (0 if none)
 *   reject the k* largest
 * </pre>
 *
 * <p>Because {@code K / (k * alpha) &gt;= 1 / alpha} for every {@code k &lt;= K}, this threshold is
 * never weaker than a bare Ville test at alpha. The per-hypothesis guarantee is therefore subsumed:
 * one check, not two.
 *
 * <h2>What it does and does not promise</h2>
 *
 * <p>FDR control holds <b>per scan</b>. Per-hypothesis type-I error is controlled over all time by
 * the supermartingale property of each e-value. There is no construction giving always-valid FDR
 * across unboundedly many scans, and claiming one would be false.
 */
public final class EBenjaminiHochberg {

    private EBenjaminiHochberg() {
    }

    /**
     * @param logEValues one log e-value per hypothesis in the family
     * @param alpha the false-discovery rate to hold to
     * @return a mask, parallel to the input, of which hypotheses are rejected
     */
    public static boolean[] reject(double[] logEValues, double alpha) {
        if (logEValues == null || logEValues.length == 0) {
            return new boolean[0];
        }
        boolean[] rejected = new boolean[logEValues.length];
        if (!(alpha > 0) || !(alpha < 1)) {
            return rejected;
        }

        int familySize = logEValues.length;
        Integer[] order = new Integer[familySize];
        for (int i = 0; i < familySize; i++) {
            order[i] = i;
        }
        // Descending by evidence. Ties broken by index so the outcome is deterministic across runs.
        java.util.Arrays.sort(order, (a, b) -> {
            int byEvidence = Double.compare(logEValues[b], logEValues[a]);
            return byEvidence != 0 ? byEvidence : Integer.compare(a, b);
        });

        int cutoff = 0;
        for (int rank = 1; rank <= familySize; rank++) {
            if (logEValues[order[rank - 1]] >= logThreshold(rank, familySize, alpha)) {
                cutoff = rank;
            }
        }
        for (int rank = 0; rank < cutoff; rank++) {
            rejected[order[rank]] = true;
        }
        return rejected;
    }

    /**
     * The rejection boundary in log space for rank {@code k} in a family of {@code familySize}:
     * {@code ln(familySize / (k * alpha))}.
     */
    public static double logThreshold(int rank, int familySize, double alpha) {
        return Math.log(familySize) - Math.log(rank) - Math.log(alpha);
    }
}
