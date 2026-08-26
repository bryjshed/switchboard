package com.switchboard.domain.webhook;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Resource filtering and retry pacing - the two rules a webhook's behaviour rests on. */
class WebhookMatchingTest {

    private static final UUID ORG = UUID.randomUUID();
    private static final UUID PROJECT_A = UUID.randomUUID();
    private static final UUID PROJECT_B = UUID.randomUUID();
    private static final UUID ENV_A = UUID.randomUUID();
    private static final UUID ENV_B = UUID.randomUUID();

    private static Webhook hook(List<WebhookEventType> types, UUID projectId, UUID envId, boolean enabled) {
        return new Webhook(UUID.randomUUID(), ORG, "https://example.test/hook", "s", null,
            types, projectId, envId, enabled, null, null, null);
    }

    @Test
    void anEmptyTypeListMeansEverythingNotNothing() {
        // The opposite reading would make a newly created webhook deliver nothing at all,
        // which reads as a broken integration rather than as an unset filter.
        Webhook all = hook(List.of(), null, null, true);
        for (WebhookEventType type : WebhookEventType.values()) {
            assertTrue(all.matches(type, PROJECT_A, ENV_A), "should match " + type);
        }
    }

    @Test
    void aTypeFilterExcludesEverythingElse() {
        Webhook killOnly = hook(List.of(WebhookEventType.FLAG_KILL_SWITCH), null, null, true);
        assertTrue(killOnly.matches(WebhookEventType.FLAG_KILL_SWITCH, PROJECT_A, ENV_A));
        assertFalse(killOnly.matches(WebhookEventType.FLAG_UPDATED, PROJECT_A, ENV_A));
        assertFalse(killOnly.matches(WebhookEventType.ROLLOUT_FINDING, PROJECT_A, ENV_A));
    }

    @Test
    void aProjectFilterNarrowsToThatProject() {
        Webhook scoped = hook(List.of(), PROJECT_A, null, true);
        assertTrue(scoped.matches(WebhookEventType.FLAG_UPDATED, PROJECT_A, ENV_A));
        assertFalse(scoped.matches(WebhookEventType.FLAG_UPDATED, PROJECT_B, ENV_A));
        // An org-scoped event carries no project, so a project-scoped hook must not see it.
        assertFalse(scoped.matches(WebhookEventType.ROLLOUT_FINDING, null, null));
    }

    @Test
    void anEnvironmentFilterNarrowsToThatEnvironment() {
        Webhook prodOnly = hook(List.of(), null, ENV_A, true);
        assertTrue(prodOnly.matches(WebhookEventType.FLAG_UPDATED, PROJECT_A, ENV_A));
        assertFalse(prodOnly.matches(WebhookEventType.FLAG_UPDATED, PROJECT_A, ENV_B));
    }

    @Test
    void filtersCompose() {
        Webhook narrow = hook(List.of(WebhookEventType.FLAG_KILL_SWITCH), PROJECT_A, ENV_A, true);
        assertTrue(narrow.matches(WebhookEventType.FLAG_KILL_SWITCH, PROJECT_A, ENV_A));
        assertFalse(narrow.matches(WebhookEventType.FLAG_KILL_SWITCH, PROJECT_A, ENV_B));
        assertFalse(narrow.matches(WebhookEventType.FLAG_UPDATED, PROJECT_A, ENV_A));
    }

    @Test
    void aDisabledWebhookMatchesNothing() {
        Webhook off = hook(List.of(), null, null, false);
        assertFalse(off.matches(WebhookEventType.FLAG_UPDATED, PROJECT_A, ENV_A));
    }

    @Test
    void theSecretNeverSurvivesWithoutSecret() {
        Webhook withSecret = hook(List.of(), null, null, true);
        assertEquals("s", withSecret.secret());
        assertEquals(null, withSecret.withoutSecret().secret());
        assertEquals(withSecret.url(), withSecret.withoutSecret().url(), "everything else survives");
    }

    @Test
    void backoffIsExponentialAndCapped() {
        assertEquals(Duration.ofSeconds(30), WebhookDelivery.backoff(0));
        assertEquals(Duration.ofSeconds(60), WebhookDelivery.backoff(1));
        assertEquals(Duration.ofSeconds(120), WebhookDelivery.backoff(2));
        assertEquals(Duration.ofSeconds(960), WebhookDelivery.backoff(5));
        // Never grows past the ceiling however many attempts are claimed.
        assertEquals(WebhookDelivery.backoff(WebhookDelivery.MAX_ATTEMPTS), WebhookDelivery.backoff(999));
    }

    @Test
    void unknownEventTypeNamesReadAsNullRatherThanThrowing() {
        // A filter written by a newer version must not stop an older instance reading the row.
        assertEquals(WebhookEventType.FLAG_UPDATED, WebhookEventType.fromWireName("flag.updated"));
        assertEquals(null, WebhookEventType.fromWireName("flag.invented_later"));
        assertEquals(null, WebhookEventType.fromWireName(null));
    }
}
