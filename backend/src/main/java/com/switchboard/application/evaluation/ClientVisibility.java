package com.switchboard.application.evaluation;

import com.switchboard.domain.flag.FlagAndConfig;
import com.switchboard.domain.project.SdkKeyKind;
import java.util.List;

/**
 * What a given kind of SDK key is allowed to see.
 *
 * <h2>Why this is one function called from everywhere</h2>
 *
 * <p>It would be easy to filter only the bootstrap, since that is the payload the exposure problem
 * was reported against. That would make {@code clientSideAvailable} a fig leaf: a holder of a public
 * key could enumerate every hidden flag one {@code POST /api/eval/{key}} at a time and learn both
 * that it exists and what it currently serves. So the filter applies to <em>every</em> evaluation
 * surface - native single, native bulk, OFREP single, OFREP bulk, the bootstrap, and the stream.
 *
 * <h2>Absent, not forbidden</h2>
 *
 * <p>A flag a public key may not see is treated exactly as an unknown flag: the caller gets the
 * default it passed in, at 200, with {@code SDK_DEFAULT}. Returning a 403 instead would confirm the
 * flag exists, which is the one fact this is trying not to leak - and it would also break the
 * product's fail-safe rule, that a flag system must never take an application down over a key it
 * does not recognise.
 */
public final class ClientVisibility {

    private ClientVisibility() {
    }

    /**
     * The flags this key kind may evaluate.
     *
     * <p>A {@link SdkKeyKind#SERVER} key gets the list back untouched - it is secret, it always saw
     * every flag, and making it respect {@code clientSideAvailable} would have silently emptied
     * every existing integration the moment the column was added with its {@code FALSE} default.
     */
    public static List<FlagAndConfig> visibleTo(SdkKeyKind kind, List<FlagAndConfig> flags) {
        if (kind == null || !kind.isPublic()) {
            return flags;
        }
        return flags.stream().filter(fc -> fc.flag().clientSideAvailable()).toList();
    }

    /** Whether one flag is visible, for the single-flag endpoints. */
    public static boolean isVisibleTo(SdkKeyKind kind, FlagAndConfig flag) {
        return kind == null || !kind.isPublic() || flag.flag().clientSideAvailable();
    }
}
