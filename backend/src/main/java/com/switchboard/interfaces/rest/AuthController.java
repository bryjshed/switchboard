package com.switchboard.interfaces.rest;

import com.switchboard.application.org.OrgService;
import com.switchboard.application.user.UserService;
import com.switchboard.domain.org.MembershipView;
import com.switchboard.interfaces.rest.api.AuthApi;
import com.switchboard.interfaces.rest.model.OrgRole;
import com.switchboard.interfaces.rest.model.UserMembership;
import com.switchboard.interfaces.rest.model.UserResponse;
import com.switchboard.interfaces.security.Principals;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@RestController
public class AuthController implements AuthApi {

    private final UserService userService;
    private final OrgService orgService;

    public AuthController(UserService userService, OrgService orgService) {
        this.userService = userService;
        this.orgService = orgService;
    }

    @Override
    public Mono<ResponseEntity<UserResponse>> getMe(ServerWebExchange exchange) {
        return Principals.currentUser()
            // Accept first, so a person who has just verified their email sees the new org in
            // THIS response's memberships. membershipsOf is an uncached query, and acceptance
            // evicts PERMISSIONS, so nothing stale can answer after it.
            .flatMap(user -> userService.onVerifiedSession(
                    user.userId(), user.email(), user.issuer(), user.subject(), user.verifiedEmail())
                .thenReturn(user))
            .flatMap(user -> userService.membershipsOf(user.userId())
                .map(AuthController::toMembership)
                .collectList()
                .zipWith(orgService.canCreateOrg())
                .map(t -> new UserResponse(user.userId(), user.email(), true, t.getT2(), t.getT1())))
            .map(ResponseEntity::ok);
    }

    private static UserMembership toMembership(MembershipView view) {
        return new UserMembership(
            view.orgId(), view.orgName(), view.orgSlug(), OrgRole.fromValue(view.role()));
    }
}
