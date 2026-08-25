package com.switchboard.application.token;

import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.domain.token.PersonalAccessToken;
import com.switchboard.domain.token.PersonalAccessTokenRepository;
import com.switchboard.interfaces.security.AuthenticatedUser;
import com.switchboard.interfaces.security.SwitchboardAuthenticationManager;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import org.springframework.stereotype.Service;

/**
 * Minting and revoking personal access tokens.
 *
 * <p>A token authenticates <b>as its owner</b> and inherits their permissions unchanged. There is
 * no separate scope model, deliberately: a second authorization vocabulary is a second place for a
 * permission bug to live, and the RBAC that already exists is the one exercised on every request.
 */
@Service
public class PersonalAccessTokenService {

    /** The prefix the auth filter routes on. */
    public static final String TOKEN_PREFIX = "sb_pat_";

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int PREFIX_LENGTH = 14;
    private static final int MAX_NAME = 100;

    private final PersonalAccessTokenRepository tokens;

    public PersonalAccessTokenService(PersonalAccessTokenRepository tokens) {
        this.tokens = tokens;
    }

    /**
     * Mints a token. The full value is returned exactly once and never stored.
     *
     * <p>No permission check beyond being signed in: a token cannot do anything its owner could not
     * already do by other means, so gating creation would protect nothing while making the feature
     * unusable for anyone but an admin.
     */
    public Mono<CreatedToken> create(AuthenticatedUser caller, String name, Instant expiresAt) {
        String trimmed = name == null ? "" : name.trim();
        if (trimmed.isEmpty()) {
            return Mono.error(new ValidationException(
                "A token name is required: an unlabelled token is one nobody dares revoke later."));
        }
        if (trimmed.length() > MAX_NAME) {
            return Mono.error(new ValidationException("Token name must be at most " + MAX_NAME + " characters"));
        }
        if (expiresAt != null && !expiresAt.isAfter(Instant.now())) {
            return Mono.error(new ValidationException("expiresAt must be in the future"));
        }

        String fullToken = TOKEN_PREFIX + randomHex();
        String prefix = fullToken.substring(0, PREFIX_LENGTH) + "…";
        String hash = SwitchboardAuthenticationManager.sha256(fullToken);

        return tokens.create(caller.userId(), trimmed, prefix, hash, expiresAt)
            .map(stored -> new CreatedToken(stored, fullToken));
    }

    public Flux<PersonalAccessToken> list(AuthenticatedUser caller) {
        return tokens.findByUser(caller.userId());
    }

    /**
     * Revokes one of the caller's own tokens.
     *
     * <p>Ownership is checked rather than a permission: these are personal credentials, so even an
     * org owner has no business revoking somebody else's. A token belonging to another user reads
     * as not-found rather than forbidden, because whether it exists is not the caller's business
     * either.
     */
    public Mono<Void> revoke(AuthenticatedUser caller, UUID tokenId) {
        return tokens.findById(tokenId)
            .filter(token -> token.userId().equals(caller.userId()))
            .switchIfEmpty(Mono.error(new NotFoundException("Token not found")))
            .flatMap(token -> tokens.revoke(tokenId))
            .then();
    }

    private static String randomHex() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    /** The stored row plus the plaintext, which exists only for the length of one response. */
    public record CreatedToken(PersonalAccessToken stored, String fullToken) {
    }
}
