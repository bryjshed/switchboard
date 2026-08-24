package com.switchboard.domain.changerequest;

/** Which FlagTargetingService write a change request stands for. */
public enum ChangeRequestKind {
    TARGETING_UPDATE,
    KILL_SWITCH,
    ROLLBACK
}
