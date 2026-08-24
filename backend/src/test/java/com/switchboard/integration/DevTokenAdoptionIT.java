package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.user.UserService;
import com.switchboard.domain.user.User;
import com.switchboard.interfaces.rest.model.UserResponse;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * A dev token and a real login for the same person are one identity.
 *
 * <p>Curl testing provisions a {@code dev:<email>} row. When that person later
 * signs in for real, the row must be re-keyed to the Firebase uid rather than
 * duplicated - otherwise their org memberships, their audit trail, and their
 * flags would silently split across two user ids.
 *
 * <p>The real login is driven through {@link UserService} with a synthetic uid:
 * minting a genuine Firebase token is out of scope here, and everything the
 * adoption depends on lives below the token-verification step anyway.
 */
class DevTokenAdoptionIT extends IntegrationTestBase {

    @Autowired
    private UserService users;

    @Test
    void aRealLoginAdoptsTheRowADevTokenProvisioned() {
        String email = uniqueEmail("adoptee");

        UserResponse provisioned = signIn(email);
        assertThat(firebaseUid(provisioned.getId())).isEqualTo("dev:" + email);

        String realUid = "firebase-uid-" + UUID.randomUUID();
        User adopted = users.resolveFirebaseUser(realUid, email, "Adoptee").block(DB_TIMEOUT);

        // Same identity, re-keyed rather than duplicated.
        assertThat(adopted.id()).isEqualTo(provisioned.getId());
        assertThat(adopted.firebaseUid()).isEqualTo(realUid);
        assertThat(firebaseUid(provisioned.getId())).doesNotStartWith("dev:");
        assertThat(countByEmail(email)).isEqualTo(1);

        // The adoption is idempotent: signing in again finds the row by uid.
        User again = users.resolveFirebaseUser(realUid, email, "Adoptee").block(DB_TIMEOUT);
        assertThat(again.id()).isEqualTo(provisioned.getId());
        assertThat(countByEmail(email)).isEqualTo(1);
    }

    @Test
    void aRealLoginWithNoExistingRowProvisionsExactlyOneUser() {
        String email = uniqueEmail("newcomer");
        String realUid = "firebase-uid-" + UUID.randomUUID();

        User created = users.resolveFirebaseUser(realUid, email, "Newcomer").block(DB_TIMEOUT);

        assertThat(created.firebaseUid()).isEqualTo(realUid);
        assertThat(countByEmail(email)).isEqualTo(1);

        // A later dev token for the same email must reuse the real row, not shadow it.
        UserResponse viaDevToken = signIn(email);
        assertThat(viaDevToken.getId()).isEqualTo(created.id());
        assertThat(countByEmail(email)).isEqualTo(1);
    }

    private String firebaseUid(UUID userId) {
        return selectOne("SELECT firebase_uid FROM users WHERE id = :id",
            String.class, Map.of("id", userId));
    }

    private long countByEmail(String email) {
        return selectOne("SELECT count(*) FROM users WHERE email = :email",
            Long.class, Map.of("email", email));
    }
}
