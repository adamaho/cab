import type { BrowserMcp } from "./browser-mcp.ts";

export interface AgentStep {
  readonly observation: unknown;
  readonly command?: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly summary?: string;
}

export interface AgentRunResult {
  readonly status: "completed" | "stopped" | "failed";
  readonly message: string;
  readonly steps: readonly AgentStep[];
}

export interface ModelLoadProgress {
  readonly progress: number;
  readonly text: string;
}

export interface BrowserLanguageModelSession {
  prompt(input: string, onProgress?: (generatedCharacters: number) => void): Promise<string>;
  interrupt?(): void;
  destroy?(): void | Promise<void>;
}

export type BrowserLanguageModelFactory = (
  onProgress?: (report: ModelLoadProgress) => void,
) => Promise<BrowserLanguageModelSession>;

async function webLlmModelFactory(
  onProgress?: (report: ModelLoadProgress) => void,
): Promise<BrowserLanguageModelSession> {
  const { createWebLlmModel } = await import("./webllm-model.ts");
  return createWebLlmModel(onProgress);
}

async function promptWithTimeout(
  model: BrowserLanguageModelSession,
  input: string,
  timeoutMs: number,
  onProgress?: (generatedCharacters: number) => void,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      model.prompt(input, onProgress),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          model.interrupt?.();
          reject(
            new Error(
              `The local model did not finish within ${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseDecision(value: string): {
  readonly done?: boolean;
  readonly summary?: string;
  readonly command?: string;
  readonly args?: unknown;
} {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object")
    throw new Error("The model returned a non-object decision");
  return parsed as { done?: boolean; summary?: string; command?: string; args?: unknown };
}

/** Runs an observe-act loop entirely inside the browser. @category agent @since 0.0.0 */
export async function runLocalAgent(options: {
  readonly goal: string;
  readonly mcp: BrowserMcp;
  readonly createModel?: BrowserLanguageModelFactory;
  readonly maxSteps?: number;
  readonly generationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onModelProgress?: (report: ModelLoadProgress) => void;
  readonly onStatus?: (status: string) => void;
  readonly onStep?: (step: AgentStep) => void;
}): Promise<AgentRunResult> {
  const goal = options.goal.trim();
  if (!goal) return { status: "failed", message: "Enter a goal for the agent", steps: [] };
  const steps: AgentStep[] = [];
  let model: BrowserLanguageModelSession | undefined;
  function interrupt() {
    model?.interrupt?.();
  }
  options.signal?.addEventListener("abort", interrupt);
  try {
    model = await (options.createModel ?? webLlmModelFactory)(options.onModelProgress);
    const maxSteps = options.maxSteps ?? 12;
    options.onStatus?.("Model ready. Observing the current screen…");
    for (let index = 0; index < maxSteps; index += 1) {
      if (options.signal?.aborted) return { status: "stopped", message: "Agent stopped", steps };
      const observation = await options.mcp.call("discoverScreen");
      options.onStatus?.(`Model ready. Thinking through step ${index + 1} of ${maxSteps}…`);
      const decision = parseDecision(
        await promptWithTimeout(
          model,
          `You steer the Cab application by choosing one command at a time.
Goal: ${goal}
Current screen: ${JSON.stringify(observation)}
Previous steps: ${JSON.stringify(steps.map(({ command, args, result }) => ({ command, args, result })))}
Return only JSON. To act: {"command":"one capability from Current screen","args":{...}}. When the goal is visibly complete: {"done":true,"summary":"..."}. Never invent commands or visible IDs.`,
          options.generationTimeoutMs ?? 120_000,
          (characters) =>
            options.onStatus?.(
              `Generating decision for step ${index + 1} of ${maxSteps}… ${characters} characters`,
            ),
        ),
      );
      if (options.signal?.aborted) return { status: "stopped", message: "Agent stopped", steps };
      if (decision.done) {
        const step = { observation, summary: decision.summary ?? "Goal completed" };
        steps.push(step);
        options.onStep?.(step);
        return { status: "completed", message: step.summary, steps };
      }
      if (!decision.command) throw new Error("The model decision did not include a command");
      const capabilities = (observation as { capabilities?: readonly { command: string }[] })
        .capabilities;
      if (!capabilities?.some((capability) => capability.command === decision.command)) {
        throw new Error(`The model chose unavailable command "${decision.command}"`);
      }
      options.onStatus?.(`Executing ${decision.command}…`);
      const result = await options.mcp.call(decision.command, decision.args ?? {});
      const step = { observation, command: decision.command, args: decision.args ?? {}, result };
      steps.push(step);
      options.onStep?.(step);
    }
    return {
      status: "failed",
      message: `Agent reached the ${options.maxSteps ?? 12}-step safety limit`,
      steps,
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      steps,
    };
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
    await model?.destroy?.();
  }
}
