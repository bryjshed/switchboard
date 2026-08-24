package com.switchboard.application.ai;

/** What a scan job did, straight into JobRunResponse. */
public record JobResult(String job, int itemsScanned, int findingsCreated, String detail) {
}
