package com.switchboard.domain.evaluation;

import java.util.ArrayList;
import java.util.List;

/**
 * Just enough of semver 2.0.0 to order two version strings, and no more.
 *
 * <p>Hand-rolled rather than a dependency because every SDK in every language has to reproduce this
 * ordering <em>identically</em> - the same argument that picked MD5 for bucketing. A library here
 * would be a library each SDK author has to find an exact equivalent of, and "close enough" is how
 * a flag ends up on for a user on the server and off in their browser.
 *
 * <p>Deliberately lenient about the leading {@code v} and about missing minor/patch segments, since
 * {@code 4}, {@code v4.2} and {@code 4.2.0} all turn up in real user agents and app builds. Strict
 * about everything else: anything it cannot parse returns null and its clause is false.
 */
public record Semver(long major, long minor, long patch, List<String> preRelease) implements Comparable<Semver> {

    public Semver {
        preRelease = preRelease == null ? List.of() : List.copyOf(preRelease);
    }

    /** @return null when {@code text} is not a version this can order */
    public static Semver parse(String text) {
        if (text == null) {
            return null;
        }
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (trimmed.startsWith("v") || trimmed.startsWith("V")) {
            trimmed = trimmed.substring(1);
        }

        // Build metadata is explicitly NOT part of precedence in semver 2.0.0, so it is discarded
        // rather than compared: 1.0.0+a and 1.0.0+b are the same version.
        int build = trimmed.indexOf('+');
        if (build >= 0) {
            trimmed = trimmed.substring(0, build);
        }

        String core = trimmed;
        List<String> preRelease = List.of();
        int dash = trimmed.indexOf('-');
        if (dash >= 0) {
            core = trimmed.substring(0, dash);
            String tail = trimmed.substring(dash + 1);
            if (tail.isEmpty()) {
                return null;
            }
            preRelease = List.of(tail.split("\\.", -1));
            if (preRelease.stream().anyMatch(String::isEmpty)) {
                return null;
            }
        }

        String[] parts = core.split("\\.", -1);
        if (parts.length == 0 || parts.length > 3) {
            return null;
        }
        List<Long> numbers = new ArrayList<>(3);
        for (String part : parts) {
            Long parsed = parseNumeric(part);
            if (parsed == null) {
                return null;
            }
            numbers.add(parsed);
        }
        while (numbers.size() < 3) {
            numbers.add(0L);
        }
        return new Semver(numbers.get(0), numbers.get(1), numbers.get(2), preRelease);
    }

    @Override
    public int compareTo(Semver other) {
        int result = Long.compare(major, other.major);
        if (result != 0) {
            return result;
        }
        result = Long.compare(minor, other.minor);
        if (result != 0) {
            return result;
        }
        result = Long.compare(patch, other.patch);
        if (result != 0) {
            return result;
        }
        return comparePreRelease(preRelease, other.preRelease);
    }

    /**
     * Semver 2.0.0 section 11: a version WITH a pre-release ranks below the same version without
     * one, so 1.0.0-rc.1 &lt; 1.0.0. Getting this backwards would ship a release candidate to
     * everyone waiting for the release.
     */
    private static int comparePreRelease(List<String> left, List<String> right) {
        if (left.isEmpty() && right.isEmpty()) {
            return 0;
        }
        if (left.isEmpty()) {
            return 1;
        }
        if (right.isEmpty()) {
            return -1;
        }
        int shared = Math.min(left.size(), right.size());
        for (int i = 0; i < shared; i++) {
            int result = compareIdentifier(left.get(i), right.get(i));
            if (result != 0) {
                return result;
            }
        }
        return Integer.compare(left.size(), right.size());
    }

    /** Numeric identifiers compare numerically and always rank below alphanumeric ones. */
    private static int compareIdentifier(String left, String right) {
        Long leftNumber = parseNumeric(left);
        Long rightNumber = parseNumeric(right);
        if (leftNumber != null && rightNumber != null) {
            return Long.compare(leftNumber, rightNumber);
        }
        if (leftNumber != null) {
            return -1;
        }
        if (rightNumber != null) {
            return 1;
        }
        return left.compareTo(right);
    }

    /** Digits only, no sign, no leading zeros beyond "0" itself - as the spec requires. */
    private static Long parseNumeric(String text) {
        if (text == null || text.isEmpty() || text.length() > 18) {
            return null;
        }
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) < '0' || text.charAt(i) > '9') {
                return null;
            }
        }
        if (text.length() > 1 && text.charAt(0) == '0') {
            return null;
        }
        return Long.parseLong(text);
    }
}
