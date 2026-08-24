package com.switchboard.domain.ai;

/** A natural-language change request; env/flag hints are optional. */
public record NlRequest(String prompt, String environmentKey, String flagKey) {
}
