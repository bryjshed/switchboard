package com.switchboard.application.project;

import com.switchboard.domain.project.SdkKey;

/** A freshly minted SDK key; {@code fullKey} is exposed only at creation time. */
public record CreatedSdkKey(SdkKey stored, String fullKey) {
}
