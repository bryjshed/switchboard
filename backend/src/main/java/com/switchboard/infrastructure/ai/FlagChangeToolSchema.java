package com.switchboard.infrastructure.ai;

import com.anthropic.core.JsonValue;
import com.anthropic.models.messages.Tool;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The single tool the assistant may call. Its input schema mirrors the REST
 * FlagChangeDiff with one deliberate difference, spelled out in the tool
 * description so the model cannot miss it: everything inside envChanges names
 * variations by their VALUE string, never by UUID, because a FLAG_CREATE
 * proposal describes variations that do not exist yet.
 */
final class FlagChangeToolSchema {

    static final String TOOL_NAME = "propose_flag_change";

    private static final String DESCRIPTION = """
        Propose exactly one feature-flag change for review. Never applies anything by itself.

        IMPORTANT - variation references: inside envChanges, every variation is named by its
        VALUE string (for example "true", "false", "control", "variant-b"), NEVER by UUID.
        A FLAG_CREATE proposal describes a flag that does not exist yet, so no UUID could be
        known; the server resolves value -> UUID when the proposal is applied.

        Only set the fields the change actually needs. Any field left out of a targeting object
        keeps the environment's current value, so a small edit stays a small diff.

        kind semantics:
          FLAG_CREATE - flagKey must be new; set flagKind, variations (>= 2 for STRING), envChanges.
          FLAG_UPDATE - flagKey must already exist; set envChanges only.
          ROLLBACK    - set rollbackToVersion and exactly one envChange naming the environment.
          RETIREMENT  - set retirementChecklist; the flag is archived on apply.
        Rollout weights must sum to exactly 100.
        """;

    private FlagChangeToolSchema() {
    }

    static Tool tool() {
        return Tool.builder()
            .name(TOOL_NAME)
            .description(DESCRIPTION)
            .inputSchema(Tool.InputSchema.builder()
                .type(JsonValue.from("object"))
                .properties(Tool.InputSchema.Properties.builder()
                    .putAdditionalProperty("kind", JsonValue.from(enumProp(
                        "What the proposal does.",
                        List.of("FLAG_CREATE", "FLAG_UPDATE", "ROLLBACK", "RETIREMENT"))))
                    .putAdditionalProperty("flagKey", JsonValue.from(stringProp(
                        "Kebab-case flag key the change applies to.")))
                    .putAdditionalProperty("name", JsonValue.from(stringProp("Human-readable flag name.")))
                    .putAdditionalProperty("description", JsonValue.from(stringProp("What the flag controls.")))
                    .putAdditionalProperty("flagKind", JsonValue.from(enumProp(
                        "BOOLEAN or STRING; FLAG_CREATE only.", List.of("BOOLEAN", "STRING"))))
                    .putAdditionalProperty("variations", JsonValue.from(arrayProp(
                        "Variations to create; STRING flags need at least 2. FLAG_CREATE only.",
                        objectSchema(Map.of(
                            "value", stringProp("The value served, as a string."),
                            "name", stringProp("Short label.")), List.of("value")))))
                    .putAdditionalProperty("tags", JsonValue.from(arrayProp(
                        "Free-form tags.", stringProp("tag"))))
                    .putAdditionalProperty("envChanges", JsonValue.from(arrayProp(
                        "Per-environment changes.", envChangeSchema())))
                    .putAdditionalProperty("rollbackToVersion", JsonValue.from(intProp(
                        "Version number to roll back to; ROLLBACK only.")))
                    .putAdditionalProperty("retirementChecklist", JsonValue.from(arrayProp(
                        "Ordered removal steps; RETIREMENT only.", stringProp("step"))))
                    .putAdditionalProperty("rationale", JsonValue.from(stringProp(
                        "One or two sentences explaining the change to a reviewer.")))
                    .build())
                .required(List.of("kind", "flagKey", "rationale"))
                .build())
            .build();
    }

    // ---------------------------------------------------------------- schema fragments

    private static Map<String, Object> envChangeSchema() {
        return objectSchema(Map.of(
            "envKey", stringProp("Environment key, for example production."),
            "enabled", boolProp("Whether the flag is on in this environment."),
            "killSwitchActive", boolProp("Whether the kill switch is engaged."),
            "targeting", targetingSchema()), List.of("envKey"));
    }

    private static Map<String, Object> targetingSchema() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("individualTargets", arrayProp(
            "Context keys pinned to a variation.",
            objectSchema(Map.of(
                "contextKey", stringProp("The context key to pin."),
                "variationValue", stringProp("Variation VALUE to serve.")),
                List.of("contextKey", "variationValue"))));
        props.put("rules", arrayProp("Ordered targeting rules.", ruleSchema()));
        props.put("fallthrough", serveSchema("What everyone else gets."));
        props.put("offVariationValue", stringProp("Variation VALUE served when the flag is off."));
        props.put("defaultVariationValue", stringProp("Variation VALUE used as the default."));
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("description",
            "Targeting for this environment. Omit any field to leave the current value untouched. "
                + "All variation references are VALUE strings, not UUIDs.");
        schema.put("properties", props);
        return schema;
    }

    private static Map<String, Object> ruleSchema() {
        return objectSchema(Map.of(
            "description", stringProp("Why this rule exists."),
            "clauses", arrayProp("All clauses must match.", clauseSchema()),
            "serve", serveSchema("What matching contexts get.")), List.of("clauses", "serve"));
    }

    private static Map<String, Object> clauseSchema() {
        return objectSchema(Map.of(
            "attribute", stringProp("Context attribute, for example country or plan."),
            "op", enumProp("Comparison operator.", List.of(
                "IN", "NOT_IN", "CONTAINS", "STARTS_WITH", "ENDS_WITH",
                "MATCHES", "GREATER_THAN", "LESS_THAN", "SEGMENT_MATCH", "NOT_SEGMENT_MATCH")),
            "values", arrayProp("Values to compare against; segment keys for SEGMENT_MATCH.",
                stringProp("value"))), List.of("attribute", "op", "values"));
    }

    private static Map<String, Object> serveSchema(String description) {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("variationValue", stringProp("Serve this variation VALUE to everyone. Omit when using rollout."));
        props.put("rollout", arrayProp(
            "Percentage rollout; weights must sum to exactly 100. Omit when using variationValue.",
            objectSchema(Map.of(
                "variationValue", stringProp("Variation VALUE."),
                "weight", intProp("Percentage 0-100.")), List.of("variationValue", "weight"))));
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("description", description + " Set exactly one of variationValue or rollout.");
        schema.put("properties", props);
        return schema;
    }

    private static Map<String, Object> objectSchema(Map<String, Object> properties, List<String> required) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("properties", new LinkedHashMap<>(properties));
        schema.put("required", required);
        return schema;
    }

    private static Map<String, Object> arrayProp(String description, Map<String, Object> items) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "array");
        schema.put("description", description);
        schema.put("items", items);
        return schema;
    }

    private static Map<String, Object> stringProp(String description) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "string");
        schema.put("description", description);
        return schema;
    }

    private static Map<String, Object> boolProp(String description) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "boolean");
        schema.put("description", description);
        return schema;
    }

    private static Map<String, Object> intProp(String description) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "integer");
        schema.put("description", description);
        return schema;
    }

    private static Map<String, Object> enumProp(String description, List<String> values) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "string");
        schema.put("description", description);
        schema.put("enum", values);
        return schema;
    }
}
