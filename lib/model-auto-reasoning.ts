import type { Api, Model } from "@earendil-works/pi-ai";
import { capabilityRecord, isAutoOnlyThinkingMap } from "./model-capabilities";

type PayloadHook<M> = (payload: unknown, model: M) => unknown | Promise<unknown>;

/** Some Pi adapters translate the internal off level into explicit provider
 * controls. An Auto-only preset delegates that decision to the provider. */
export function withProviderDefaultThinking<M extends Model<Api>, T extends { onPayload?: PayloadHook<M> }>(
  model: M,
  options: T | undefined,
  selectedAuto = false,
): T | undefined {
  if (!model.reasoning || (!selectedAuto && !isAutoOnlyThinkingMap(model.thinkingLevelMap))) return options;
  return {
    ...options,
    onPayload(payload: unknown, requestModel: M) {
      const request = capabilityRecord(payload);
      if (request) {
        if (requestModel.api === "google-generative-ai" || requestModel.api === "google-vertex") {
          const config = capabilityRecord(request.config) ?? capabilityRecord(request.generationConfig);
          if (config) delete config.thinkingConfig;
        } else if (requestModel.api === "anthropic-messages") {
          delete request.thinking;
          const output = capabilityRecord(request.output_config);
          if (output) {
            delete output.effort;
            if (Object.keys(output).length === 0) delete request.output_config;
          }
        } else if (["openai-responses", "openai-codex-responses", "azure-openai-responses", "openai-completions"].includes(requestModel.api)) {
          delete request.reasoning;
          delete request.reasoning_effort;
          delete request.thinking;
          delete request.enable_thinking;
          const kwargs = capabilityRecord(request.chat_template_kwargs);
          if (kwargs) {
            delete kwargs.enable_thinking;
            if (Object.keys(kwargs).length === 0) delete request.chat_template_kwargs;
          }
        }
      }
      return options?.onPayload?.(payload, requestModel);
    },
  } as T;
}
