package com.switchboard.infrastructure.config;

import com.switchboard.application.org.OrgCreationPolicy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Binds {@code switchboard.org-creation} once, so a typo fails startup rather than a request. */
@Configuration
public class OrgCreationConfig {

    @Bean
    public OrgCreationPolicy orgCreationPolicy(@Value("${switchboard.org-creation:open}") String value) {
        return OrgCreationPolicy.parse(value);
    }
}
