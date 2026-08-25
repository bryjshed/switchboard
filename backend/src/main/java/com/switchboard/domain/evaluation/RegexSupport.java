package com.switchboard.domain.evaluation;

import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * The {@code MATCHES} operator, restricted to a portable, non-catastrophic subset.
 *
 * <h2>Two problems, one answer</h2>
 *
 * <p><b>Backtracking.</b> A rule's pattern is untrusted input evaluated on the hot path.
 * {@code java.util.regex} and JavaScript's {@code RegExp} are both backtracking engines, so a
 * pattern like {@code (a+)+$} against a long non-matching string takes exponential time. Somebody
 * with permission to edit a flag should not be able to stop evaluation for everyone, whether by
 * malice or by copying a pattern off the internet.
 *
 * <p><b>Dialect drift.</b> The server evaluates in Java and an SDK evaluates the same rule in
 * JavaScript. If a pattern means different things in the two engines - or compiles in one and not
 * the other - the same flag serves different answers in the browser and on the server, which is
 * precisely what the conformance vectors exist to prevent.
 *
 * <p>Both are answered by narrowing what a pattern may contain, identically in every
 * implementation: <b>no lookaround, no backreferences, and a length cap</b>. What is left is the
 * common core that Java, JavaScript, Go and RE2 all agree on, and it is what a flag rule actually
 * needs - character classes, alternation, anchors and quantifiers.
 *
 * <p>An unsupported or unparseable pattern makes the clause <b>false</b> rather than throwing. Both
 * implementations reach the same answer for the same reason, so conformance holds even for a
 * pattern neither will run.
 */
public final class RegexSupport {

    /**
     * Long enough for any legitimate targeting rule, short enough to bound the damage of a
     * pathological one. A pattern longer than this is far more likely to be pasted than written.
     */
    public static final int MAX_PATTERN_LENGTH = 512;

    /**
     * The input is capped too. A bounded pattern against an unbounded string is still unbounded
     * work, and an attribute arrives from whoever is calling the SDK.
     */
    public static final int MAX_INPUT_LENGTH = 4096;

    private RegexSupport() {
    }

    /**
     * True when {@code input} matches {@code pattern} anywhere within it.
     *
     * <p>Unanchored, matching JavaScript's {@code RegExp.test}. An author who wants the whole string
     * writes {@code ^...$}, which reads more clearly than an invisible anchoring rule.
     */
    public static boolean matches(String input, String pattern) {
        if (input == null || pattern == null) {
            return false;
        }
        if (input.length() > MAX_INPUT_LENGTH || !isSupported(pattern)) {
            return false;
        }
        try {
            return Pattern.compile(pattern).matcher(input).find();
        } catch (PatternSyntaxException e) {
            // An invalid pattern is an authoring mistake, not a request failure.
            return false;
        }
    }

    /**
     * Whether a pattern is inside the portable subset.
     *
     * <p>Public and deliberately simple: the TypeScript SDK implements the identical check, and a
     * rule that needs a comment to port is a rule the two will eventually disagree about.
     */
    public static boolean isSupported(String pattern) {
        if (pattern == null || pattern.isEmpty() || pattern.length() > MAX_PATTERN_LENGTH) {
            return false;
        }
        for (int i = 0; i < pattern.length(); i++) {
            char current = pattern.charAt(i);

            if (current == '\\') {
                if (i + 1 >= pattern.length()) {
                    // A trailing backslash escapes nothing and is a syntax error in both engines.
                    return false;
                }
                char escaped = pattern.charAt(i + 1);
                // \1 .. \9 are backreferences, which RE2-style engines do not have at all. \0 is a
                // NUL escape and is allowed.
                if (escaped >= '1' && escaped <= '9') {
                    return false;
                }
                i++;
                continue;
            }

            // (?= (?! (?<= (?<! -- lookahead and lookbehind. (?: and (?<name> are fine.
            if (current == '(' && i + 2 < pattern.length() && pattern.charAt(i + 1) == '?') {
                char kind = pattern.charAt(i + 2);
                if (kind == '=' || kind == '!') {
                    return false;
                }
                if (kind == '<' && i + 3 < pattern.length()) {
                    char after = pattern.charAt(i + 3);
                    if (after == '=' || after == '!') {
                        return false;
                    }
                }
            }
        }
        return true;
    }
}
