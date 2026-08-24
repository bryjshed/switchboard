package com.switchboard.application.flag;

import com.switchboard.domain.flag.FlagEnvConfigVersion;
import java.util.List;

public record VersionPage(List<FlagEnvConfigVersion> items, String nextCursor) {
}
