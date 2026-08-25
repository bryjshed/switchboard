package com.switchboard.interfaces.rest;

import com.switchboard.application.token.PersonalAccessTokenService;
import com.switchboard.domain.token.PersonalAccessToken;
import com.switchboard.interfaces.rest.api.TokensApi;
import com.switchboard.interfaces.rest.model.PersonalAccessTokenCreateRequest;
import com.switchboard.interfaces.rest.model.PersonalAccessTokenCreatedResponse;
import com.switchboard.interfaces.rest.model.PersonalAccessTokenResponse;
import com.switchboard.interfaces.security.Principals;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Personal access tokens: the caller's own, and only ever their own. */
@RestController
public class TokensController implements TokensApi {

    private final PersonalAccessTokenService tokens;

    public TokensController(PersonalAccessTokenService tokens) {
        this.tokens = tokens;
    }

    @Override
    public Mono<ResponseEntity<PersonalAccessTokenCreatedResponse>> createMyToken(
        Mono<PersonalAccessTokenCreateRequest> request, ServerWebExchange exchange) {

        return Principals.currentUser()
            .zipWith(request)
            .flatMap(t -> tokens.create(t.getT1(), t.getT2().getName(), t.getT2().getExpiresAt()))
            .map(created -> ResponseEntity.status(HttpStatus.CREATED).body(
                new PersonalAccessTokenCreatedResponse(
                    created.stored().id(),
                    created.stored().name(),
                    created.stored().tokenPrefix(),
                    // The one and only time this value leaves the server.
                    created.fullToken(),
                    created.stored().createdAt())
                    .expiresAt(created.stored().expiresAt())));
    }

    @Override
    public Mono<ResponseEntity<Flux<PersonalAccessTokenResponse>>> listMyTokens(
        ServerWebExchange exchange) {

        return Principals.currentUser()
            .map(user -> ResponseEntity.ok(tokens.list(user).map(TokensController::toResponse)));
    }

    @Override
    public Mono<ResponseEntity<Void>> revokeMyToken(UUID tokenId, ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> tokens.revoke(user, tokenId))
            .thenReturn(ResponseEntity.noContent().build());
    }

    private static PersonalAccessTokenResponse toResponse(PersonalAccessToken token) {
        return new PersonalAccessTokenResponse(
            token.id(), token.name(), token.tokenPrefix(), token.createdAt())
            .expiresAt(token.expiresAt())
            .lastUsedAt(token.lastUsedAt())
            .revokedAt(token.revokedAt());
    }
}
