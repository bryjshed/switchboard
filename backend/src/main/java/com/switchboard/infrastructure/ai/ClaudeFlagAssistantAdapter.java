package com.switchboard.infrastructure.ai;

import com.anthropic.client.AnthropicClient;
import com.anthropic.models.messages.ContentBlock;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.ThinkingConfigDisabled;
import com.anthropic.models.messages.ToolUseBlock;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.switchboard.domain.ai.AiFunctionConfig;
import com.switchboard.domain.ai.AiFunctionConfigRepository;
import com.switchboard.domain.ai.AnomalyInput;
import com.switchboard.domain.ai.DraftResult;
import com.switchboard.domain.ai.EnvChange;
import com.switchboard.domain.ai.FlagAssistantPort;
import com.switchboard.domain.ai.FlagChangeDiff;
import com.switchboard.domain.ai.FlagSnapshotItem;
import com.switchboard.domain.ai.NlRequest;
import com.switchboard.domain.ai.ProjectSnapshot;
import com.switchboard.domain.ai.ProposalKind;
import com.switchboard.domain.ai.RetirementInput;
import com.switchboard.domain.ai.ValueServe;
import com.switchboard.domain.ai.ValueWeight;
import com.switchboard.domain.common.AiUnavailableException;
import com.switchboard.domain.common.ValidationException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Claude-backed assistant. Every call reads its model, temperature, and token
 * cap from ai_function_configs, so the model can be retuned without a deploy.
 *
 * <p>Drafting forces the single {@code propose_flag_change} tool, which is what
 * makes the response parseable JSON rather than prose to scrape. When the parsed
 * input fails structural validation the adapter retries exactly once with the
 * validation error appended, then gives up with a ValidationException.
 *
 * <p>The SDK is blocking, so every call is wrapped in
 * {@code Mono.fromCallable(...).subscribeOn(boundedElastic())}.
 */
public class ClaudeFlagAssistantAdapter implements FlagAssistantPort {

    private static final Logger log = LoggerFactory.getLogger(ClaudeFlagAssistantAdapter.class);

    private static final String FN_NL_FLAG_OPS = "nl_flag_ops";
    private static final String FN_ROLLOUT_MONITOR = "rollout_monitor";
    private static final String FN_STALE_SWEEP = "stale_sweep";

    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() {
    };

    private final AnthropicClient client;
    private final AiFunctionConfigRepository configs;
    private final ObjectMapper json;

    public ClaudeFlagAssistantAdapter(
        AnthropicClient client, AiFunctionConfigRepository configs, ObjectMapper json) {
        this.client = client;
        this.configs = configs;
        this.json = json;
    }

    // ---------------------------------------------------------------- drafting

    @Override
    public Mono<DraftResult> draftProposal(NlRequest request, ProjectSnapshot snapshot) {
        return config(FN_NL_FLAG_OPS).flatMap(config -> {
            String system = systemPrompt(snapshot);
            String user = userPrompt(request);
            return call(config, system, user, null)
                .flatMap(first -> Mono.fromCallable(() -> parse(first))
                    .onErrorResume(ValidationException.class, e -> call(config, system, user, e.getMessage())
                        .flatMap(second -> Mono.fromCallable(() -> parse(second)))));
        });
    }

    /** One forced-tool round trip; {@code retryNote} appends the previous validation failure. */
    private Mono<ObjectNode> call(AiFunctionConfig config, String system, String user, String retryNote) {
        String message = retryNote == null
            ? user
            : user + "\n\nYour previous call was rejected: " + retryNote + "\nFix it and call the tool again.";
        return Mono.fromCallable(() -> {
                MessageCreateParams.Builder params = MessageCreateParams.builder()
                    .model(config.modelId())
                    .maxTokens(config.maxTokens())
                    .system(system)
                    .addUserMessage(message)
                    .addTool(FlagChangeToolSchema.tool())
                    .toolToolChoice(FlagChangeToolSchema.TOOL_NAME)
                    // Forced tool choice and extended thinking are mutually exclusive.
                    .thinking(ThinkingConfigDisabled.builder().build());
                applyTemperature(params, config);
                Message response = client.messages().create(params.build());
                return toolInput(response);
            })
            .subscribeOn(Schedulers.boundedElastic())
            .onErrorMap(e -> !(e instanceof ValidationException) && !(e instanceof AiUnavailableException),
                e -> {
                    log.warn("Claude draft call failed", e);
                    return new AiUnavailableException("AI provider call failed: " + e.getMessage());
                });
    }

    private ObjectNode toolInput(Message response) {
        return response.content().stream()
            .map(ContentBlock::toolUse)
            .flatMap(Optional::stream)
            .filter(block -> FlagChangeToolSchema.TOOL_NAME.equals(block.name()))
            .findFirst()
            .map(this::inputNode)
            .orElseThrow(() -> new ValidationException(
                "The assistant did not call " + FlagChangeToolSchema.TOOL_NAME));
    }

    private ObjectNode inputNode(ToolUseBlock block) {
        return json.convertValue(block._input().convert(Object.class), ObjectNode.class);
    }

    /**
     * Tool input -&gt; domain diff. Anything the model can get structurally wrong
     * (missing key, unknown kind, weights that do not sum to 100, a serve that
     * sets both or neither branch) becomes a ValidationException, which is what
     * the single retry feeds back to the model.
     */
    private DraftResult parse(ObjectNode input) {
        String rationale = input.path("rationale").asText(null);
        ObjectNode diffNode = input.deepCopy();
        diffNode.remove("rationale");
        FlagChangeDiff diff;
        try {
            diff = json.treeToValue(diffNode, FlagChangeDiff.class);
        } catch (Exception e) {
            throw new ValidationException("Tool input is not a valid flag change: " + e.getMessage());
        }
        validate(diff);
        return new DraftResult(diff, rationale == null || rationale.isBlank() ? "AI-drafted change" : rationale);
    }

    private static void validate(FlagChangeDiff diff) {
        if (diff.kind() == null) {
            throw new ValidationException("kind is required");
        }
        if (diff.flagKey() == null || diff.flagKey().isBlank()) {
            throw new ValidationException("flagKey is required");
        }
        if (diff.kind() == ProposalKind.ROLLBACK && diff.rollbackToVersion() == null) {
            throw new ValidationException("ROLLBACK requires rollbackToVersion");
        }
        if (diff.kind() == ProposalKind.FLAG_CREATE && diff.flagKind() == null) {
            throw new ValidationException("FLAG_CREATE requires flagKind");
        }
        for (EnvChange change : diff.envChanges()) {
            if (change.envKey() == null || change.envKey().isBlank()) {
                throw new ValidationException("every envChange requires envKey");
            }
            if (change.targeting() == null) {
                continue;
            }
            validateServe(change.targeting().fallthrough());
            change.targeting().rules().forEach(rule -> validateServe(rule.serve()));
        }
    }

    private static void validateServe(ValueServe serve) {
        if (serve == null) {
            return;
        }
        boolean hasValue = serve.variationValue() != null && !serve.variationValue().isBlank();
        if (hasValue == serve.hasRollout()) {
            throw new ValidationException("a serve must set exactly one of variationValue or rollout");
        }
        if (serve.hasRollout()) {
            int sum = serve.rollout().stream().mapToInt(ValueWeight::weight).sum();
            if (sum != 100) {
                throw new ValidationException("rollout weights must sum to exactly 100, got " + sum);
            }
        }
    }

    // ---------------------------------------------------------------- monitor prose

    @Override
    public Mono<String> summarizeAnomaly(AnomalyInput input) {
        String prompt = String.format(
            Locale.ROOT,
            """
            A percentage rollout is degrading in production telemetry. Write one or two plain sentences
            a reviewer can act on. No preamble, no bullet points, no markdown.

            Flag: %s
            Environment: %s
            Metric: %s
            Variation under test: %s - rate %.4f over %d evaluations
            Baseline variation: %s - rate %.4f over %d evaluations
            Two-proportion z-score: %.2f
            """,
            input.flagKey(), input.envKey(), input.metricKey(),
            input.variationLabel(), input.variantRate(), input.variantSamples(),
            input.baselineLabel(), input.baselineRate(), input.baselineSamples(),
            input.zScore());
        return text(FN_ROLLOUT_MONITOR, prompt)
            .onErrorResume(e -> fallback().summarizeAnomaly(input));
    }

    @Override
    public Mono<List<String>> draftRetirementChecklist(RetirementInput input) {
        String prompt = String.format(
            Locale.ROOT,
            """
            Flag %s ("%s") has been unchanged for %d weeks across environments %s and is safe to retire.
            List the ordered steps an engineer should take to remove it. Reply with a JSON array of
            plain strings and nothing else.
            """,
            input.flagKey(), input.flagName(), input.weeksSinceChange(), String.join(", ", input.envKeys()));
        return text(FN_STALE_SWEEP, prompt)
            .map(this::parseChecklist)
            .onErrorResume(e -> fallback().draftRetirementChecklist(input));
    }

    private List<String> parseChecklist(String raw) {
        int start = raw.indexOf('[');
        int end = raw.lastIndexOf(']');
        if (start < 0 || end <= start) {
            throw new ValidationException("checklist was not a JSON array");
        }
        try {
            return json.readValue(raw.substring(start, end + 1), STRING_LIST);
        } catch (Exception e) {
            throw new ValidationException("checklist was not a JSON array: " + e.getMessage());
        }
    }

    private Mono<String> text(String functionKey, String prompt) {
        return config(functionKey).flatMap(config -> Mono.fromCallable(() -> {
                MessageCreateParams.Builder params = MessageCreateParams.builder()
                    .model(config.modelId())
                    .maxTokens(config.maxTokens())
                    .addUserMessage(prompt);
                applyTemperature(params, config);
                return client.messages().create(params.build()).content().stream()
                    .map(ContentBlock::text)
                    .flatMap(Optional::stream)
                    .map(block -> block.text())
                    .collect(Collectors.joining("\n"))
                    .trim();
            })
            .subscribeOn(Schedulers.boundedElastic()));
    }

    /** The monitor must keep working when the provider misbehaves; drafting must not. */
    private static FlagAssistantPort fallback() {
        return new NoopFlagAssistantAdapter();
    }

    // ---------------------------------------------------------------- plumbing

    private Mono<AiFunctionConfig> config(String functionKey) {
        return configs.find(functionKey)
            .switchIfEmpty(Mono.error(new AiUnavailableException(
                "No ai_function_configs row for " + functionKey)))
            .flatMap(config -> config.enabled()
                ? Mono.just(config)
                : Mono.error(new AiUnavailableException("AI function " + functionKey + " is disabled")));
    }

    /**
     * Claude 4.6-and-newer models reject temperature outright, so the configured
     * value is only sent to models that still accept sampling parameters.
     */
    private static void applyTemperature(MessageCreateParams.Builder params, AiFunctionConfig config) {
        if (acceptsTemperature(config.modelId())) {
            params.temperature(config.temperature());
        }
    }

    private static boolean acceptsTemperature(String modelId) {
        String id = modelId.toLowerCase(Locale.ROOT);
        return !(id.contains("-5") || id.contains("-4-6") || id.contains("-4-7") || id.contains("-4-8"));
    }

    private static String systemPrompt(ProjectSnapshot snapshot) {
        List<String> lines = new ArrayList<>();
        lines.add("You are Switchboard's feature-flag assistant. Translate one operator request into one "
            + "typed flag change by calling the propose_flag_change tool. Never invent flag keys, "
            + "environment keys, segment keys, or variation values that are not listed below.");
        lines.add("");
        lines.add("Project: " + snapshot.projectKey());
        lines.add("Environments: " + joinOrNone(snapshot.envKeys()));
        lines.add("Segments: " + joinOrNone(snapshot.segmentKeys()));
        lines.add("Context attributes already in use: " + joinOrNone(snapshot.attributeHints()));
        lines.add("");
        lines.add("Existing flags (key | kind | variation values | tags):");
        if (snapshot.flags().isEmpty()) {
            lines.add("  (none)");
        } else {
            for (FlagSnapshotItem flag : snapshot.flags()) {
                lines.add("  " + flag.key() + " | " + flag.kind() + " | "
                    + joinOrNone(flag.variationValues()) + " | " + joinOrNone(flag.tags()));
            }
        }
        lines.add("");
        lines.add("Rules: pick FLAG_CREATE only when the key is absent from the list above. "
            + "Pick FLAG_UPDATE when it is present. Reference variations by VALUE, never by id.");
        return String.join("\n", lines);
    }

    private static String userPrompt(NlRequest request) {
        StringBuilder prompt = new StringBuilder();
        if (request.environmentKey() != null && !request.environmentKey().isBlank()) {
            prompt.append("Target environment: ").append(request.environmentKey()).append('\n');
        }
        if (request.flagKey() != null && !request.flagKey().isBlank()) {
            prompt.append("Target flag: ").append(request.flagKey()).append('\n');
        }
        prompt.append("Request: ").append(request.prompt());
        return prompt.toString();
    }

    private static String joinOrNone(List<String> values) {
        return values.isEmpty() ? "(none)" : String.join(", ", values);
    }
}
