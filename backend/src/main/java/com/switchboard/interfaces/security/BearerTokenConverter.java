package com.switchboard.interfaces.security;

import org.springframework.http.HttpHeaders;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.server.authentication.ServerAuthenticationConverter;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * Extracts the pre-authentication token from a request.
 *
 * <p>Two carriers, one token type. {@code Authorization: Bearer <token>} is the native carrier and
 * takes precedence. {@code X-API-Key: <sdk key>} exists because OFREP defines exactly those two
 * schemes (bearer and the {@code X-API-Key} apiKey scheme) and OpenFeature providers pick either;
 * both produce the same {@link BearerTokenAuthenticationToken}, so
 * {@link SwitchboardAuthenticationManager} resolves them identically and an SDK key sent either
 * way ends up as the same {@link SdkKeyPrincipal}.
 *
 * <p>{@code X-API-Key} is restricted to SDK keys on purpose: it is the SDK surface's header, and
 * letting a user credential in through a second door would widen the management surface for no
 * caller that exists. A non-SDK value is simply not a credential here, which the filter chain
 * turns into 401 rather than a misleading 403.
 */
@Component
public class BearerTokenConverter implements ServerAuthenticationConverter {

    /** OFREP's apiKey security scheme header name. */
    public static final String API_KEY_HEADER = "X-API-Key";

    private static final String BEARER = "Bearer ";

    @Override
    public Mono<Authentication> convert(ServerWebExchange exchange) {
        HttpHeaders headers = exchange.getRequest().getHeaders();
        String token = bearerToken(headers.getFirst(HttpHeaders.AUTHORIZATION));
        if (token == null) {
            token = sdkKeyHeader(headers.getFirst(API_KEY_HEADER));
        }
        return token == null ? Mono.empty() : Mono.just(new BearerTokenAuthenticationToken(token));
    }

    private static String bearerToken(String header) {
        if (header == null || !header.startsWith(BEARER)) {
            return null;
        }
        String token = header.substring(BEARER.length()).trim();
        return token.isEmpty() ? null : token;
    }

    private static String sdkKeyHeader(String header) {
        if (header == null) {
            return null;
        }
        String token = header.trim();
        return token.startsWith(SwitchboardAuthenticationManager.SDK_KEY_PREFIX) ? token : null;
    }
}
