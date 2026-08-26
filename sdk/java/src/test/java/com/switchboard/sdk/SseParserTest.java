package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.switchboard.sdk.internal.SseParser;
import com.switchboard.sdk.internal.Transport;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The SSE framing rules that are easy to get wrong, each pinned by the case that would have
 * caught it. Every one of these produced a real bug in some SSE client somewhere.
 */
class SseParserTest {

    private static List<Transport.SseEvent> parse(String stream) throws IOException {
        List<Transport.SseEvent> events = new ArrayList<>();
        SseParser.parse(new ByteArrayInputStream(stream.getBytes(StandardCharsets.UTF_8)), events::add);
        return events;
    }

    @Test
    void dispatchesOnBlankLineNotPerLine() throws IOException {
        // The failure this prevents: dispatching per line splits a pretty-printed JSON
        // payload into fragments, each of which is invalid JSON on its own.
        var events = parse("event: put\ndata: {\ndata:   \"a\": 1\ndata: }\n\n");
        assertEquals(1, events.size());
        assertEquals("put", events.getFirst().event());
        assertEquals("{\n  \"a\": 1\n}", events.getFirst().data());
    }

    @Test
    void stripsExactlyOneSpaceAfterTheColon() throws IOException {
        var events = parse("data:  two spaces\n\n");
        assertEquals(" two spaces", events.getFirst().data());
    }

    @Test
    void ignoresComments() throws IOException {
        var events = parse(": this is a heartbeat comment\ndata: real\n\n");
        assertEquals(1, events.size());
        assertEquals("real", events.getFirst().data());
    }

    @Test
    void idPersistsAcrossEventsUntilReplaced() throws IOException {
        // Last-Event-ID reconnection depends on this: the server sends an id once and it
        // applies until changed. Resetting it per event would ask for the wrong catch-up.
        var events = parse("id: 7\ndata: a\n\ndata: b\n\nid: 9\ndata: c\n\n");
        assertEquals(3, events.size());
        assertEquals("7", events.get(0).id());
        assertEquals("7", events.get(1).id());
        assertEquals("9", events.get(2).id());
    }

    @Test
    void doesNotDispatchAnEventWithNoData() throws IOException {
        var events = parse("event: ping\n\ndata: real\n\n");
        assertEquals(1, events.size());
        assertEquals("real", events.getFirst().data());
    }

    @Test
    void defaultsTheEventTypeToMessage() throws IOException {
        assertEquals("message", parse("data: x\n\n").getFirst().event());
    }

    @Test
    void resetsEventTypeBetweenEvents() throws IOException {
        // event: is per-event; leaking it forward would turn a later untyped event into a
        // second "put" and reapply a whole payload as though it were fresh.
        var events = parse("event: put\ndata: a\n\ndata: b\n\n");
        assertEquals("put", events.get(0).event());
        assertEquals("message", events.get(1).event());
    }

    @Test
    void toleratesATrailingIncompleteEvent() throws IOException {
        // A dropped connection mid-event must not surface a half-parsed payload.
        var events = parse("data: complete\n\ndata: incomp");
        assertEquals(1, events.size());
        assertTrue(events.getFirst().data().equals("complete"));
    }
}
