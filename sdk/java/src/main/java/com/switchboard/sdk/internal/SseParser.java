package com.switchboard.sdk.internal;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/**
 * A minimal but correct Server-Sent Events reader, per the WHATWG event-stream rules.
 *
 * <p>Hand-written because the JDK has no SSE client and pulling one in for ~60 lines would
 * cost the SDK a dependency for no gain. The parts that are easy to get wrong and are
 * therefore handled deliberately:
 *
 * <ul>
 *   <li><b>A blank line dispatches the event.</b> Fields accumulate until then. Parsing
 *       line-by-line and dispatching per line would split a multi-line {@code data:} payload
 *       into fragments of invalid JSON.</li>
 *   <li><b>Multiple {@code data:} lines join with a newline</b> and the trailing newline is
 *       dropped. A pretty-printed JSON payload arrives this way.</li>
 *   <li><b>One optional space after the colon is stripped</b>, and only one.</li>
 *   <li><b>A line starting with a colon is a comment</b> and is ignored - which is what a
 *       heartbeat often is.</li>
 *   <li><b>An event with no data is not dispatched</b>, per the spec.</li>
 * </ul>
 */
public final class SseParser {

    private SseParser() {
    }

    public static void parse(InputStream stream, Consumer<Transport.SseEvent> onEvent) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        StringBuilder data = new StringBuilder();
        String id = null;
        String eventType = null;

        String line;
        while ((line = reader.readLine()) != null) {
            if (Thread.currentThread().isInterrupted()) {
                return;
            }
            if (line.isEmpty()) {
                if (!data.isEmpty()) {
                    // Strip exactly the one trailing newline the join added.
                    if (data.charAt(data.length() - 1) == '\n') {
                        data.setLength(data.length() - 1);
                    }
                    onEvent.accept(new Transport.SseEvent(id, eventType == null ? "message" : eventType, data.toString()));
                }
                data.setLength(0);
                eventType = null;
                continue;
            }
            if (line.charAt(0) == ':') {
                continue;
            }
            int colon = line.indexOf(':');
            String field = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (!value.isEmpty() && value.charAt(0) == ' ') {
                value = value.substring(1);
            }
            switch (field) {
                case "data" -> data.append(value).append('\n');
                case "event" -> eventType = value;
                // id persists across events until the server sends another, which is what
                // makes Last-Event-ID on reconnect meaningful.
                case "id" -> id = value;
                default -> { /* retry: and unknown fields are ignored */ }
            }
        }
    }
}
