package com.switchboard.interfaces.security;

import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import reactor.core.publisher.Mono;

public final class Principals {

    private Principals() {
    }

    public static Mono<AuthenticatedUser> currentUser() {
        return ReactiveSecurityContextHolder.getContext()
            .map(ctx -> ctx.getAuthentication())
            .filter(auth -> auth.getPrincipal() instanceof AuthenticatedUser)
            .map(auth -> (AuthenticatedUser) auth.getPrincipal());
    }

    public static Mono<SdkKeyPrincipal> currentSdkKey() {
        return ReactiveSecurityContextHolder.getContext()
            .map(ctx -> ctx.getAuthentication().getPrincipal())
            .filter(p -> p instanceof SdkKeyPrincipal)
            .map(p -> (SdkKeyPrincipal) p);
    }
}
