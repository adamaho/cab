import {
  CreateWebWorkerMLCEngine,
  type InitProgressReport,
  type WebWorkerMLCEngine,
} from "@mlc-ai/web-llm";
import type { BrowserLanguageModelSession } from "./local-agent.ts";

export const LOCAL_AGENT_MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

/** Loads Cab's local model into a dedicated Web Worker backed by WebGPU. @category agent @since 0.0.0 */
export async function createWebLlmModel(
  onProgress?: (report: InitProgressReport) => void,
): Promise<BrowserLanguageModelSession> {
  if (!("gpu" in navigator)) {
    throw new Error("WebGPU is unavailable in this browser. The local WebLLM agent cannot run.");
  }
  const worker = new Worker(new URL("./webllm-worker.ts", import.meta.url), { type: "module" });
  let engine: WebWorkerMLCEngine | undefined;
  try {
    engine = await CreateWebWorkerMLCEngine(
      worker,
      LOCAL_AGENT_MODEL,
      onProgress ? { initProgressCallback: onProgress } : {},
    );
  } catch (error) {
    worker.terminate();
    throw error;
  }
  return {
    async prompt(input, onProgress) {
      const chunks = await engine.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a careful UI steering agent. Follow the requested JSON response format exactly.",
          },
          { role: "user", content: input },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 96,
        stream: true,
      });
      let content = "";
      for await (const chunk of chunks) {
        content += chunk.choices[0]?.delta.content ?? "";
        onProgress?.(content.length);
      }
      if (!content) throw new Error("WebLLM returned an empty decision");
      return content;
    },
    interrupt: () => engine.interruptGenerate(),
    async destroy() {
      await engine.unload();
      worker.terminate();
    },
  };
}
