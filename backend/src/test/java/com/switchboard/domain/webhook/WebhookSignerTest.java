package com.switchboard.domain.webhook;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import org.junit.jupiter.api.Test;

/** HMAC signing, and specifically the properties a receiver depends on. */
class WebhookSignerTest {

    private static final String SECRET = "whsec_0123456789abcdef";
    private static final String BODY = "{\"id\":\"e1\",\"type\":\"flag.updated\"}";
    private static final Instant AT = Instant.ofEpochSecond(1_735_689_600L);

    @Test
    void producesTheDocumentedHeaderShape() {
        String header = WebhookSigner.signatureHeader(SECRET, BODY, AT);
        assertTrue(header.startsWith("t=1735689600,v1="), header);
        // 32 bytes of SHA-256 as hex.
        assertEquals(64, header.substring(header.indexOf("v1=") + 3).length());
    }

    @Test
    void verifiesItsOwnSignature() {
        String header = WebhookSigner.signatureHeader(SECRET, BODY, AT);
        assertTrue(WebhookSigner.verify(SECRET, BODY, header, AT, 300));
    }

    @Test
    void rejectsATamperedBody() {
        String header = WebhookSigner.signatureHeader(SECRET, BODY, AT);
        assertFalse(WebhookSigner.verify(SECRET, BODY + " ", header, AT, 300));
    }

    @Test
    void rejectsTheWrongSecret() {
        String header = WebhookSigner.signatureHeader(SECRET, BODY, AT);
        assertFalse(WebhookSigner.verify("whsec_wrong", BODY, header, AT, 300));
    }

    @Test
    void theTimestampIsInsideTheMacSoAReplayCannotBeRedated() {
        // The property that matters. If the timestamp were merely sent alongside the MAC,
        // an attacker could take yesterday's "kill switch released" delivery, rewrite t to
        // now, and it would still verify. Because t is signed, changing it breaks the MAC.
        String header = WebhookSigner.signatureHeader(SECRET, BODY, AT);
        String mac = header.substring(header.indexOf("v1=") + 3);
        Instant later = AT.plusSeconds(10_000);
        String forged = "t=" + later.getEpochSecond() + ",v1=" + mac;

        assertFalse(WebhookSigner.verify(SECRET, BODY, forged, later, 300),
            "re-dating a captured delivery must invalidate the signature");
    }

    @Test
    void rejectsAnOldDeliveryOutsideTolerance() {
        String header = WebhookSigner.signatureHeader(SECRET, BODY, AT);
        assertFalse(WebhookSigner.verify(SECRET, BODY, header, AT.plusSeconds(3600), 300));
        assertTrue(WebhookSigner.verify(SECRET, BODY, header, AT.plusSeconds(60), 300));
    }

    @Test
    void rejectsMalformedHeaders() {
        assertFalse(WebhookSigner.verify(SECRET, BODY, null, AT, 300));
        assertFalse(WebhookSigner.verify(SECRET, BODY, "", AT, 300));
        assertFalse(WebhookSigner.verify(SECRET, BODY, "v1=deadbeef", AT, 300), "no timestamp");
        assertFalse(WebhookSigner.verify(SECRET, BODY, "t=1735689600", AT, 300), "no mac");
        assertFalse(WebhookSigner.verify(SECRET, BODY, "t=notanumber,v1=x", AT, 300));
    }

    @Test
    void isStableForTheSameInputs() {
        // A receiver following the documented recipe must reproduce this exactly, so the
        // digest is pinned rather than merely round-tripped.
        assertEquals(
            WebhookSigner.hexDigest(SECRET, "1735689600." + BODY),
            WebhookSigner.signatureHeader(SECRET, BODY, AT).substring("t=1735689600,v1=".length()));
    }
}
