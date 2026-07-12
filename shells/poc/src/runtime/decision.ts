import type { EffectInvocation, EventInvocation } from "./definition.ts";

/** Explains a deterministic domain-level command refusal. @category decisions @since 0.0.0 */
export interface CommandRejection {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

/** Is the complete pure result of deciding one command. @category decisions @since 0.0.0 */
export type Decision =
  | {
      readonly _tag: "Accepted";
      readonly events: readonly [
        EventInvocation<string, unknown>,
        ...EventInvocation<string, unknown>[],
      ];
      readonly effects: readonly EffectInvocation<string, unknown>[];
    }
  | { readonly _tag: "Rejected"; readonly rejection: CommandRejection }
  | { readonly _tag: "Noop"; readonly reason?: string };

/** Pure constructors for accepted, rejected, and idempotent decisions. @category decisions @since 0.0.0 */
export const Decision = {
  accept(input: {
    readonly events: readonly [
      EventInvocation<string, unknown>,
      ...EventInvocation<string, unknown>[],
    ];
    readonly effects?: readonly EffectInvocation<string, unknown>[];
  }): Extract<Decision, { readonly _tag: "Accepted" }> {
    return { _tag: "Accepted", events: input.events, effects: input.effects ?? [] };
  },
  reject(
    code: string,
    message: string,
    details?: unknown,
  ): Extract<Decision, { readonly _tag: "Rejected" }> {
    return details === undefined
      ? { _tag: "Rejected", rejection: { code, message } }
      : { _tag: "Rejected", rejection: { code, message, details } };
  },
  noop(reason?: string): Extract<Decision, { readonly _tag: "Noop" }> {
    return reason === undefined ? { _tag: "Noop" } : { _tag: "Noop", reason };
  },
} as const;
