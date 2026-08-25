package com.switchboard.testsupport;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.Map;

/**
 * A real OIDC issuer, in-process: an RSA key pair, a JWKS endpoint that publishes its public half,
 * a discovery document, and a token minter.
 *
 * <p>It exists so provider-agnosticism can be demonstrated rather than asserted. Firebase is the
 * only implementation the codebase has ever had; an abstraction exercised by one implementation is
 * not an abstraction. This issuer is not Firebase in any respect - different keys, different
 * issuer URL, signed rather than unsigned, arbitrary claim names - so a token from it
 * authenticating against the real API is evidence the seam is real.
 */
public final class TestOidcIssuer implements AutoCloseable {

    private final HttpServer server;
    private final RSAKey key;
    private final String issuer;

    public TestOidcIssuer() {
        try {
            this.key = new RSAKeyGenerator(2048).keyID("test-key-1").generate();
            this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot start a test OIDC issuer", e);
        }
        this.issuer = "http://127.0.0.1:" + server.getAddress().getPort();
        server.createContext("/jwks.json", exchange -> respond(exchange,
            new JWKSet(key.toPublicJWK()).toString()));
        server.createContext("/.well-known/openid-configuration", exchange -> respond(exchange,
            "{\"issuer\":\"" + issuer + "\",\"jwks_uri\":\"" + issuer + "/jwks.json\"}"));
        server.start();
    }

    public String issuer() {
        return issuer;
    }

    public String jwkSetUri() {
        return issuer + "/jwks.json";
    }

    /** A signed, currently-valid token carrying the given claims on top of iss/sub/aud/iat/exp. */
    public String mint(String subject, String audience, Map<String, Object> claims) {
        return mint(subject, audience, claims, Instant.now().plusSeconds(300));
    }

    public String mint(
        String subject, String audience, Map<String, Object> claims, Instant expiry) {
        JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder()
            .issuer(issuer)
            .subject(subject)
            .audience(audience)
            .issueTime(new Date())
            .expirationTime(Date.from(expiry));
        claims.forEach(builder::claim);
        SignedJWT jwt = new SignedJWT(
            new JWSHeader.Builder(JWSAlgorithm.RS256)
                .keyID(key.getKeyID())
                .type(JOSEObjectType.JWT)
                .build(),
            builder.build());
        try {
            jwt.sign(new RSASSASigner(key));
        } catch (Exception e) {
            throw new IllegalStateException("Cannot sign a test token", e);
        }
        return jwt.serialize();
    }

    private static void respond(HttpExchange exchange, String body) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        try {
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.getResponseBody().close();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
