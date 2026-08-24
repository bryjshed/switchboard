package com.switchboard.domain.user;

import java.util.UUID;

public record User(
    UUID id,
    String firebaseUid,
    String email,
    String displayName,
    boolean onboardingCompleted) {
}
