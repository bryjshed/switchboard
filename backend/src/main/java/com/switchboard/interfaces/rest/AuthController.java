package com.switchboard.interfaces.rest;

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

    public AuthController(UserService userService) {
        this.userService = userService;
    }

    @Override
    public Mono<ResponseEntity<UserResponse>> getMe(ServerWebExchange exchange) {
        return Principals.currentUser()
            .flatMap(user -> userService.membershipsOf(user.userId())
                .map(AuthController::toMembership)
                .collectList()
                .map(memberships -> new UserResponse(user.userId(), user.email(), true, memberships)))
            .map(ResponseEntity::ok);
    }

    private static UserMembership toMembership(MembershipView view) {
        return new UserMembership(
            view.orgId(), view.orgName(), view.orgSlug(), OrgRole.fromValue(view.role()));
    }
}
