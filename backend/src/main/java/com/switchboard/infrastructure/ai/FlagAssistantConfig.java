package com.switchboard.infrastructure.ai;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.switchboard.domain.ai.AiFunctionConfigRepository;
import com.switchboard.domain.ai.FlagAssistantPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Picks the assistant adapter from configuration alone: a non-blank
 * {@code switchboard.ai.anthropic-api-key} selects the Claude adapter, anything
 * else selects the keyless no-op. Deployments without a key stay fully
 * functional - drafting returns 503 and the monitor uses templated prose.
 */
@Configuration
public class FlagAssistantConfig {

    private static final Logger log = LoggerFactory.getLogger(FlagAssistantConfig.class);

    @Bean
    public FlagAssistantPort flagAssistantPort(
        @Value("${switchboard.ai.anthropic-api-key:}") String apiKey,
        AiFunctionConfigRepository configs,
        ObjectMapper json) {

        if (apiKey == null || apiKey.isBlank()) {
            log.info("No switchboard.ai.anthropic-api-key configured: AI drafting will return 503");
            return new NoopFlagAssistantAdapter();
        }
        AnthropicClient client = AnthropicOkHttpClient.builder().apiKey(apiKey).build();
        log.info("Claude flag assistant enabled");
        return new ClaudeFlagAssistantAdapter(client, configs, json);
    }
}
