package com.switchboard.infrastructure.persistence.adapter;

import com.switchboard.domain.ai.AiFunctionConfig;
import com.switchboard.domain.ai.AiFunctionConfigRepository;
import java.math.BigDecimal;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Mono;

/** Reads ai_function_configs; the row is the single source of model/temperature/max-tokens. */
@Repository
public class AiFunctionConfigRepositoryAdapter implements AiFunctionConfigRepository {

    private final DatabaseClient db;

    public AiFunctionConfigRepositoryAdapter(DatabaseClient db) {
        this.db = db;
    }

    @Override
    public Mono<AiFunctionConfig> find(String functionKey) {
        return db.sql("""
                SELECT function_key, model_id, temperature, max_tokens, enabled
                FROM ai_function_configs WHERE function_key = :key
                """)
            .bind("key", functionKey)
            .map(row -> new AiFunctionConfig(
                row.get("function_key", String.class),
                row.get("model_id", String.class),
                row.get("temperature", BigDecimal.class).doubleValue(),
                row.get("max_tokens", Integer.class),
                Boolean.TRUE.equals(row.get("enabled", Boolean.class))))
            .one();
    }
}
