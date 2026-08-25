package com.switchboard.infrastructure.config;

import com.switchboard.interfaces.security.BearerTokenConverter;
import com.switchboard.interfaces.security.SwitchboardAuthenticationManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.SecurityWebFiltersOrder;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.security.web.server.authentication.AuthenticationWebFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.reactive.CorsConfigurationSource;
import org.springframework.web.cors.reactive.UrlBasedCorsConfigurationSource;
import reactor.core.publisher.Mono;

import java.util.List;

@Configuration
@EnableWebFluxSecurity
public class SecurityConfig {

    @Bean
    public SecurityWebFilterChain securityWebFilterChain(
        ServerHttpSecurity http,
        SwitchboardAuthenticationManager authManager,
        BearerTokenConverter converter) {

        AuthenticationWebFilter authFilter = new AuthenticationWebFilter(authManager);
        authFilter.setServerAuthenticationConverter(converter);

        return http
            .csrf(ServerHttpSecurity.CsrfSpec::disable)
            .httpBasic(ServerHttpSecurity.HttpBasicSpec::disable)
            .formLogin(ServerHttpSecurity.FormLoginSpec::disable)
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .authorizeExchange(exchanges -> exchanges
                // Actuator. These are mapped on the MANAGEMENT port only (management.server.port),
                // so permitAll here does not expose them on the public listener: the path is
                // unmapped there and 404s after passing this rule. The port is the real boundary -
                // bind it to the pod or host network and never publish it. The filter chain does
                // apply to the management listener, which is why prometheus needs naming: without
                // it the scrape 401s and the endpoint is silently useless.
                .pathMatchers("/actuator/health", "/actuator/health/**",
                    "/actuator/info", "/actuator/prometheus").permitAll()
                // Job triggers authenticate via the X-Job-Token shared secret in the controller.
                .pathMatchers("/api/jobs/**").permitAll()
                // SDK surface, including OFREP - one SDK key, whether it arrives as a bearer
                // token or in OFREP's X-API-Key header.
                .pathMatchers("/api/eval/**", "/api/eval", "/api/stream", "/api/events/**", "/ofrep/**")
                .hasRole("SDK")
                .anyExchange().hasRole("USER"))
            .exceptionHandling(handling -> handling
                .authenticationEntryPoint((exchange, ex) -> Mono.fromRunnable(() ->
                    exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED)))
                .accessDeniedHandler((exchange, ex) -> Mono.fromRunnable(() ->
                    exchange.getResponse().setStatusCode(HttpStatus.FORBIDDEN))))
            .addFilterAt(authFilter, SecurityWebFiltersOrder.AUTHENTICATION)
            .build();
    }

    private CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOriginPatterns(List.of("*"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }
}
