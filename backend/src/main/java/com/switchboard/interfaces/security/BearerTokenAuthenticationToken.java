package com.switchboard.interfaces.security;

import org.springframework.security.authentication.AbstractAuthenticationToken;

/** Pre-authentication holder for the raw bearer token. */
public class BearerTokenAuthenticationToken extends AbstractAuthenticationToken {

    private final String token;

    public BearerTokenAuthenticationToken(String token) {
        super((java.util.Collection<? extends org.springframework.security.core.GrantedAuthority>) null);
        this.token = token;
        setAuthenticated(false);
    }

    @Override
    public Object getCredentials() {
        return token;
    }

    @Override
    public Object getPrincipal() {
        return token;
    }

    public String token() {
        return token;
    }
}
