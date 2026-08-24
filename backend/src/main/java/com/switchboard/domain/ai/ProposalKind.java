package com.switchboard.domain.ai;

/** What an AI proposal does when applied. */
public enum ProposalKind {
    FLAG_CREATE,
    FLAG_UPDATE,
    ROLLBACK,
    RETIREMENT
}
