package com.switchboard.domain.access;

/** The three levels a role can be granted at, narrowing left to right. */
public enum ScopeType {
    ORG,
    PROJECT,
    ENVIRONMENT
}
