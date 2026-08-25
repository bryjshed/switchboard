package com.switchboard.infrastructure.config;

import com.switchboard.application.ai.RolloutMonitorProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * Binds the AI layer's configuration properties.
 *
 * <p>{@link RolloutMonitorProperties} lives in {@code application/} because it is what the monitor
 * decides with, not how it is wired; the registration sits here so the application layer does not
 * have to carry a {@code @Configuration} of its own.
 */
@Configuration
@EnableConfigurationProperties(RolloutMonitorProperties.class)
public class AiConfig {
}
