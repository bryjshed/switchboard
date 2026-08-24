package com.switchboard.application.audit;

import java.util.List;

public record AuditPage(List<AuditEntry> items, String nextCursor) {
}
