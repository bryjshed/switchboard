package com.switchboard.domain.ai;

/** Lifecycle of an AI proposal; only DRAFT is applicable. */
public enum ProposalStatus {
    DRAFT,
    APPLIED,
    REJECTED,
    EXPIRED
}
