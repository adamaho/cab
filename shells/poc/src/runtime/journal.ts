import { Context, Data, Effect, Layer } from "effect";
import { cloneSerializable, isSerializable } from "./feature.ts";
import type { CommitEnvelope, CommittedEffectInvocation, Fact, RenderToken } from "./model.ts";

/** Is the complete in-memory journal and transactional outbox snapshot. @category journal @since 0.0.0 */
export interface JournalSnapshot {
  readonly facts: readonly Fact[];
  readonly invocations: readonly CommittedEffectInvocation[];
  readonly branchId: string;
  readonly branchEpoch: number;
}

/** Appends one already-validated command transaction atomically. @category journal @since 0.0.0 */
export interface JournalTransaction {
  readonly commit: CommitEnvelope;
  readonly expectedHeadSequence: number;
  readonly facts: readonly Fact[];
  readonly invocations: readonly CommittedEffectInvocation[];
}

/** Reports journal transaction, branch, or serialization failures. @category errors @since 0.0.0 */
export class JournalCommitError extends Data.TaggedError("JournalCommitError")<{
  readonly code:
    | "stale-head"
    | "stale-branch"
    | "invalid-sequence"
    | "unserializable"
    | "unknown-invocation"
    | "decision-defect"
    | "fold-defect"
    | "invalid-definition";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Defines the atomic journal and effect outbox boundary. @category services @since 0.0.0 */
export class Journal extends Context.Service<
  Journal,
  {
    readonly snapshot: Effect.Effect<JournalSnapshot>;
    readonly commit: (transaction: JournalTransaction) => Effect.Effect<void, JournalCommitError>;
    readonly recoverClaimed: Effect.Effect<number>;
    readonly rebasePendingRenderTokens: (token: RenderToken) => Effect.Effect<void>;
    readonly claimNextPending: Effect.Effect<CommittedEffectInvocation | undefined>;
    readonly compareAndSetInvocationStatus: (
      invocationId: string,
      expected: CommittedEffectInvocation["status"],
      status: CommittedEffectInvocation["status"],
    ) => Effect.Effect<boolean, JournalCommitError>;
    readonly continueFrom: (input: {
      readonly sequence: number;
      readonly nextBranchId: string;
      readonly nextBranchEpoch: number;
      readonly renderToken?: RenderToken;
    }) => Effect.Effect<JournalSnapshot, JournalCommitError>;
  }
>()("cab/runtime/Journal") {}

function validateTransaction(
  current: JournalSnapshot,
  transaction: JournalTransaction,
): JournalCommitError | undefined {
  if (
    transaction.commit.branchId !== current.branchId ||
    transaction.commit.branchEpoch !== current.branchEpoch
  ) {
    return new JournalCommitError({
      code: "stale-branch",
      message: "The transaction targets an abandoned branch",
    });
  }
  if (transaction.expectedHeadSequence !== current.facts.length) {
    return new JournalCommitError({
      code: "stale-head",
      message: "The journal head changed before commit",
    });
  }
  for (let index = 0; index < transaction.facts.length; index += 1) {
    if (transaction.facts[index]?.sequence !== current.facts.length + index + 1) {
      return new JournalCommitError({
        code: "invalid-sequence",
        message: "The transaction does not continue journal sequence ordering",
      });
    }
  }
  if (!isSerializable(transaction.commit)) {
    return new JournalCommitError({
      code: "unserializable",
      message: "The commit envelope is not serializable",
    });
  }
  const invocationIds = new Set(current.invocations.map((invocation) => invocation.id));
  for (const value of [...transaction.facts, ...transaction.invocations]) {
    if (!isSerializable(value)) {
      return new JournalCommitError({
        code: "unserializable",
        message: "A fact or effect invocation is not serializable",
      });
    }
  }
  for (const invocation of transaction.invocations) {
    if (invocation.status !== "pending" || invocationIds.has(invocation.id)) {
      return new JournalCommitError({
        code: "invalid-definition",
        message: `Duplicate or non-pending effect invocation "${invocation.id}"`,
      });
    }
    invocationIds.add(invocation.id);
  }
  return undefined;
}

function replaceInvocation(
  snapshot: JournalSnapshot,
  index: number,
  invocation: CommittedEffectInvocation,
): JournalSnapshot {
  return cloneSerializable({
    ...snapshot,
    invocations: snapshot.invocations.map((item, itemIndex) =>
      itemIndex === index ? invocation : item,
    ),
  });
}

/** Supplies an atomic process-local journal and transactional outbox. @category layers @since 0.0.0 */
export const JournalMemoryLive = Layer.sync(Journal, () => {
  let current = cloneSerializable<JournalSnapshot>({
    facts: [],
    invocations: [],
    branchId: "branch-root",
    branchEpoch: 0,
  });

  return {
    snapshot: Effect.sync(() => current),
    commit: (transaction: JournalTransaction) =>
      Effect.gen(function* () {
        const error = validateTransaction(current, transaction);
        if (error) return yield* Effect.fail(error);
        current = cloneSerializable({
          ...current,
          facts: [...current.facts, ...transaction.facts],
          invocations: [...current.invocations, ...transaction.invocations],
        });
      }),
    recoverClaimed: Effect.sync(() => {
      let recovered = 0;
      current = cloneSerializable({
        ...current,
        invocations: current.invocations.map((invocation) => {
          if (invocation.status !== "claimed") return invocation;
          recovered += 1;
          return { ...invocation, status: "pending" as const };
        }),
      });
      return recovered;
    }),
    rebasePendingRenderTokens: (token) =>
      Effect.sync(() => {
        current = cloneSerializable({
          ...current,
          invocations: current.invocations.map((invocation) =>
            invocation.status === "pending" && invocation.phase === "after-render"
              ? { ...invocation, renderToken: token }
              : invocation,
          ),
        });
      }),
    claimNextPending: Effect.sync(() => {
      const index = current.invocations.findIndex((item) => item.status === "pending");
      if (index < 0) return undefined;
      const invocation = current.invocations[index];
      if (!invocation) return undefined;
      const claimed = cloneSerializable({ ...invocation, status: "claimed" as const });
      current = replaceInvocation(current, index, claimed);
      return claimed;
    }),
    compareAndSetInvocationStatus: (invocationId, expected, status) =>
      Effect.gen(function* () {
        const index = current.invocations.findIndex((item) => item.id === invocationId);
        if (index < 0) {
          return yield* Effect.fail(
            new JournalCommitError({
              code: "unknown-invocation",
              message: `Unknown effect invocation "${invocationId}"`,
            }),
          );
        }
        const invocation = current.invocations[index];
        if (!invocation || invocation.status !== expected) return false;
        current = replaceInvocation(current, index, cloneSerializable({ ...invocation, status }));
        return true;
      }),
    continueFrom: ({ sequence, nextBranchId, nextBranchEpoch, renderToken }) =>
      Effect.gen(function* () {
        if (sequence < 0 || sequence > current.facts.length || !Number.isInteger(sequence)) {
          return yield* Effect.fail(
            new JournalCommitError({
              code: "invalid-sequence",
              message: `Sequence ${sequence} is outside the journal`,
            }),
          );
        }
        current = cloneSerializable({
          facts: current.facts.slice(0, sequence),
          invocations: current.invocations
            .filter((invocation) => invocation.triggerSequence <= sequence)
            .map((invocation) => ({
              ...invocation,
              branchId: nextBranchId,
              branchEpoch: nextBranchEpoch,
              ...(renderToken !== undefined &&
              invocation.status === "pending" &&
              invocation.phase === "after-render"
                ? { renderToken }
                : {}),
            })),
          branchId: nextBranchId,
          branchEpoch: nextBranchEpoch,
        });
        return current;
      }),
  };
});
