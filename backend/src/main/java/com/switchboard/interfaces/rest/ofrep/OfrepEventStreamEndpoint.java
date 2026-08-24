package com.switchboard.interfaces.rest.ofrep;

/** OFREP {@code eventStreamEndpoint}; {@code requestUri} is path + query and must start with "/". */
public record OfrepEventStreamEndpoint(String requestUri) {
}
