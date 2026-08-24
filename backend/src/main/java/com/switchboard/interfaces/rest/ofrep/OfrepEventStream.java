package com.switchboard.interfaces.rest.ofrep;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * OFREP {@code eventStream}: a push channel the provider may connect to instead of polling.
 *
 * <p>The spec requires exactly one of {@code url} or {@code endpoint}; Switchboard always uses
 * {@code endpoint}, so the provider joins it to the OFREP base URL it was already configured with
 * and no origin is hard-coded server-side.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record OfrepEventStream(String type, OfrepEventStreamEndpoint endpoint, Integer inactivityDelaySec) {
}
