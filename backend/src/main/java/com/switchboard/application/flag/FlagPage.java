package com.switchboard.application.flag;

import com.switchboard.domain.flag.FlagListItem;
import java.util.List;

public record FlagPage(List<FlagListItem> items, String nextCursor) {
}
