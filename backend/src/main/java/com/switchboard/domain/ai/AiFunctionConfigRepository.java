package com.switchboard.domain.ai;

import reactor.core.publisher.Mono;

/** Reads ai_function_configs rows (nl_flag_ops, rollout_monitor, stale_sweep). */
public interface AiFunctionConfigRepository {

    Mono<AiFunctionConfig> find(String functionKey);
}
