package com.switchboard.application.flag;

/** Requested variation on flag create / patch (id assigned server-side). */
public record VariationInput(String value, String name) {
}
