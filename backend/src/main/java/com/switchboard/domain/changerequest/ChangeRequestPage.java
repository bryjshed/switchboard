package com.switchboard.domain.changerequest;

import java.util.List;

/** One keyset page of change requests, newest first. */
public record ChangeRequestPage(List<ChangeRequest> items, String nextCursor) {
}
