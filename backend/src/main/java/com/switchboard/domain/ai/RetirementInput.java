package com.switchboard.domain.ai;

import java.util.List;

/** The stale flag the assistant is asked to write a retirement checklist for. */
public record RetirementInput(String flagKey, String flagName, int weeksSinceChange, List<String> envKeys) {

    public RetirementInput {
        envKeys = envKeys == null ? List.of() : List.copyOf(envKeys);
    }
}
