package com.switchboard.domain.webhook;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * HMAC-SHA256 request signing.
 *
 * <p>The header is the scheme Stripe popularised, because it is the one receivers already
 * have library code for:
 *
 * <pre>X-Switchboard-Signature: t=1735689600,v1=9f86d081...</pre>
 *
 * <p><b>The timestamp is inside the signed material, not merely alongside it.</b> Signing the
 * body alone produces a token that stays valid forever: anyone who observes one delivery can
 * replay it indefinitely, and for a flag system a replayed "kill switch released" is a real
 * incident. Binding the timestamp into the MAC lets a receiver reject anything older than its
 * tolerance and know the timestamp itself was not tampered with.
 *
 * <p><b>{@code v1} is a version prefix and is load-bearing.</b> Receivers are told to select
 * the scheme by prefix rather than assume position, so a future {@code v2} can be sent
 * alongside {@code v1} during a migration instead of breaking every consumer at once.
 */
public final class WebhookSigner {

    /** Signed material is "{timestamp}.{body}" - see the class note on replay. */
    private static final String SEPARATOR = ".";
    private static final String ALGORITHM = "HmacSHA256";

    private WebhookSigner() {
    }

    /** The full header value for one delivery. */
    public static String signatureHeader(String secret, String body, Instant timestamp) {
        long seconds = timestamp.getEpochSecond();
        return "t=" + seconds + ",v1=" + hexDigest(secret, seconds + SEPARATOR + body);
    }

    /** The bare hex MAC, exposed for tests and for anyone verifying by hand. */
    public static String hexDigest(String secret, String signedPayload) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), ALGORITHM));
            return HexFormat.of().formatHex(mac.doFinal(signedPayload.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            // Both checked exceptions here mean the JVM lacks HmacSHA256 or the key is empty,
            // neither of which is recoverable at a call site and neither of which should be
            // reported to a receiver.
            throw new IllegalStateException("Cannot sign webhook payload", e);
        }
    }

    /**
     * Verifies a header the way a receiver should, which is what the tests assert against.
     *
     * <p>Comparison is {@link MessageDigest#isEqual}, not {@code String.equals}: a
     * short-circuiting comparison leaks how many leading characters were right, and a MAC
     * check is exactly the place that matters. Kept here so the reference implementation a
     * consumer copies is the constant-time one.
     */
    public static boolean verify(String secret, String body, String header, Instant now, long toleranceSeconds) {
        if (header == null) {
            return false;
        }
        Long timestamp = null;
        String provided = null;
        for (String part : header.split(",")) {
            String[] kv = part.trim().split("=", 2);
            if (kv.length != 2) {
                continue;
            }
            if ("t".equals(kv[0])) {
                try {
                    timestamp = Long.parseLong(kv[1]);
                } catch (NumberFormatException e) {
                    return false;
                }
            } else if ("v1".equals(kv[0])) {
                provided = kv[1];
            }
        }
        if (timestamp == null || provided == null) {
            return false;
        }
        if (Math.abs(now.getEpochSecond() - timestamp) > toleranceSeconds) {
            return false;
        }
        String expected = hexDigest(secret, timestamp + SEPARATOR + body);
        return MessageDigest.isEqual(
            expected.getBytes(StandardCharsets.UTF_8), provided.getBytes(StandardCharsets.UTF_8));
    }
}
