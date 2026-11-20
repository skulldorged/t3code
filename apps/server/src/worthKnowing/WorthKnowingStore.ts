import {
  type ThreadId,
  WorthKnowingError,
  WorthKnowingFinding,
  type WorthKnowingFindingId,
  type WorthKnowingThreadSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** How many findings one thread keeps; older ones are pruned when a new one lands. */
const MAX_FINDINGS_PER_THREAD = 50;
/** A finding the user has sent this many messages past without answering is passed over. */
export const MESSAGES_TO_PASS_OVER = 2;
/**
 * Backoff is shared by every thread and project, as Claude Code's plugin does,
 * so it lives under one key of the table that once held it per project.
 */
const BACKOFF_KEY = "*";

/** How the user has been answering findings, so checks can back off. */
export interface WorthKnowingBackoff {
  /** Findings passed over in a row. */
  readonly ignoredStreak: number;
  /** Checks still to skip before the observer looks again. */
  readonly checksToSkip: number;
}

export interface StoredWorthKnowingFinding {
  readonly finding: WorthKnowingFinding;
  /** The user acted on it: opened its source, handed it to the agent, or changed its status. */
  readonly engaged: boolean;
}

export class WorthKnowingStore extends Context.Service<
  WorthKnowingStore,
  {
    readonly get: (
      id: WorthKnowingFindingId,
    ) => Effect.Effect<StoredWorthKnowingFinding | undefined, WorthKnowingError>;
    readonly listThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<StoredWorthKnowingFinding>, WorthKnowingError>;
    /** Findings offered in any thread, newest first. */
    readonly listRecent: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<WorthKnowingFinding>, WorthKnowingError>;
    /** Topics the user dismissed, knew or took to the agent, in any thread, newest first. */
    readonly listKnown: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<WorthKnowingFinding>, WorthKnowingError>;
    readonly listOpenSummaries: Effect.Effect<
      ReadonlyArray<WorthKnowingThreadSummary>,
      WorthKnowingError
    >;
    readonly insert: (finding: WorthKnowingFinding) => Effect.Effect<void, WorthKnowingError>;
    readonly update: (
      finding: WorthKnowingFinding,
      options?: { readonly engaged?: boolean },
    ) => Effect.Effect<void, WorthKnowingError>;
    /**
     * Counts a user message sent at `sentAt` past the thread's open findings
     * that were raised before it and never opened. Those reaching
     * `MESSAGES_TO_PASS_OVER` become passed over; returns how many did.
     */
    readonly countMessagePast: (
      threadId: ThreadId,
      sentAt: string,
      now: string,
    ) => Effect.Effect<number, WorthKnowingError>;
    readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, WorthKnowingError>;
    readonly getBackoff: Effect.Effect<WorthKnowingBackoff, WorthKnowingError>;
    readonly setBackoff: (state: WorthKnowingBackoff) => Effect.Effect<void, WorthKnowingError>;
  }
>()("t3/worthKnowing/WorthKnowingStore") {}

const storeError = (operation: string) => (cause: unknown) =>
  new WorthKnowingError({ message: `Worth knowing storage failed to ${operation}.`, cause });

const decodeFinding = Schema.decodeUnknownEffect(Schema.fromJsonString(WorthKnowingFinding));
const encodeFinding = Schema.encodeEffect(Schema.fromJsonString(WorthKnowingFinding));

interface FindingRow {
  readonly payload_json: string;
  readonly engaged: number;
}

interface CountedFindingRow extends FindingRow {
  readonly id: string;
  /** Messages the user has sent past it without answering. */
  readonly ignored: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Created here rather than in a numbered migration: this table belongs to
  // the personal fork, and a fork migration would take an id upstream's next
  // migration needs.
  yield* Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS worth_knowing_findings (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          status TEXT NOT NULL,
          tag TEXT NOT NULL,
          engaged INTEGER NOT NULL DEFAULT 0,
          ignored INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_worth_knowing_findings_thread
        ON worth_knowing_findings (thread_id, created_at)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_worth_knowing_findings_project_status
        ON worth_knowing_findings (project_id, status)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS worth_knowing_projects (
          project_id TEXT PRIMARY KEY,
          ignored_streak INTEGER NOT NULL,
          checks_to_skip INTEGER NOT NULL
        )
      `,
    ],
    { discard: true },
  ).pipe(Effect.orDie);

  const decodeRows = (rows: ReadonlyArray<FindingRow>) =>
    Effect.forEach(rows, (row) =>
      decodeFinding(row.payload_json).pipe(
        Effect.map((finding) => ({ finding, engaged: row.engaged === 1 })),
      ),
    );

  const get: WorthKnowingStore["Service"]["get"] = (id) =>
    sql<FindingRow>`
      SELECT payload_json, engaged FROM worth_knowing_findings WHERE id = ${id}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows[0]),
      Effect.mapError(storeError("read a finding")),
    );

  const listThread: WorthKnowingStore["Service"]["listThread"] = (threadId) =>
    sql<FindingRow>`
      SELECT payload_json, engaged FROM worth_knowing_findings
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC
      LIMIT ${MAX_FINDINGS_PER_THREAD}
    `.pipe(Effect.flatMap(decodeRows), Effect.mapError(storeError("list a thread's findings")));

  const listRecent: WorthKnowingStore["Service"]["listRecent"] = (limit) =>
    sql<FindingRow>`
      SELECT payload_json, engaged FROM worth_knowing_findings
      ORDER BY created_at DESC
      LIMIT ${limit}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows.map((row) => row.finding)),
      Effect.mapError(storeError("list recent findings")),
    );

  const listKnown: WorthKnowingStore["Service"]["listKnown"] = (limit) =>
    sql<FindingRow>`
      SELECT payload_json, engaged FROM worth_knowing_findings
      WHERE status IN ('dismissed', 'known', 'discussed')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows.map((row) => row.finding)),
      Effect.mapError(storeError("list known topics")),
    );

  const listOpenSummaries: WorthKnowingStore["Service"]["listOpenSummaries"] = sql<{
    readonly thread_id: ThreadId;
    readonly tag: string;
    readonly created_at: string;
    readonly title: string | null;
  }>`
    SELECT thread_id, tag, created_at, json_extract(payload_json, '$.title') AS title
    FROM worth_knowing_findings
    WHERE status = 'open'
    ORDER BY created_at
  `.pipe(
    Effect.map((rows) => {
      const summaries = new Map<ThreadId, WorthKnowingThreadSummary>();
      for (const row of rows) {
        const prior = summaries.get(row.thread_id);
        const headsUp = row.tag === "heads_up";
        summaries.set(row.thread_id, {
          threadId: row.thread_id,
          openCount: (prior?.openCount ?? 0) + 1,
          headsUpCount: (prior?.headsUpCount ?? 0) + (headsUp ? 1 : 0),
          latestOpenAt: row.created_at,
          latestHeadsUpAt: headsUp ? row.created_at : (prior?.latestHeadsUpAt ?? null),
          latestHeadsUpTitle: headsUp ? row.title : (prior?.latestHeadsUpTitle ?? null),
        });
      }
      return [...summaries.values()];
    }),
    Effect.mapError(storeError("summarize open findings")),
  );

  const insert: WorthKnowingStore["Service"]["insert"] = (finding) =>
    encodeFinding(finding).pipe(
      Effect.flatMap((payload) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO worth_knowing_findings (
                id, thread_id, project_id, status, tag, created_at, payload_json
              ) VALUES (
                ${finding.id},
                ${finding.threadId},
                ${finding.projectId},
                ${finding.status},
                ${finding.tag},
                ${finding.createdAt},
                ${payload}
              )
            `;
            yield* sql`
              DELETE FROM worth_knowing_findings
              WHERE thread_id = ${finding.threadId}
                AND id NOT IN (
                  SELECT id FROM worth_knowing_findings
                  WHERE thread_id = ${finding.threadId}
                  ORDER BY created_at DESC
                  LIMIT ${MAX_FINDINGS_PER_THREAD}
                )
            `;
          }),
        ),
      ),
      Effect.mapError(storeError("save a finding")),
    );

  const update: WorthKnowingStore["Service"]["update"] = (finding, options) =>
    encodeFinding(finding).pipe(
      Effect.flatMap(
        (payload) => sql`
          UPDATE worth_knowing_findings
          SET status = ${finding.status},
              payload_json = ${payload},
              engaged = CASE WHEN ${options?.engaged === true ? 1 : 0} = 1 THEN 1 ELSE engaged END
          WHERE id = ${finding.id}
        `,
      ),
      Effect.asVoid,
      Effect.mapError(storeError("update a finding")),
    );

  const countMessagePast: WorthKnowingStore["Service"]["countMessagePast"] = (
    threadId,
    sentAt,
    now,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<CountedFindingRow>`
            SELECT id, payload_json, engaged, ignored FROM worth_knowing_findings
            WHERE thread_id = ${threadId}
              AND status = 'open'
              AND engaged = 0
              AND created_at < ${sentAt}
          `;
          let passedOver = 0;
          for (const row of rows) {
            const count = Number(row.ignored) + 1;
            if (count < MESSAGES_TO_PASS_OVER) {
              yield* sql`UPDATE worth_knowing_findings SET ignored = ${count} WHERE id = ${row.id}`;
              continue;
            }
            const finding = yield* decodeFinding(row.payload_json);
            const payload = yield* encodeFinding({
              ...finding,
              status: "passed_over",
              updatedAt: now,
            });
            yield* sql`
              UPDATE worth_knowing_findings
              SET ignored = ${count}, status = 'passed_over', payload_json = ${payload}
              WHERE id = ${row.id}
            `;
            passedOver += 1;
          }
          return passedOver;
        }),
      )
      .pipe(Effect.mapError(storeError("count a message past open findings")));

  const deleteThread: WorthKnowingStore["Service"]["deleteThread"] = (threadId) =>
    sql`DELETE FROM worth_knowing_findings WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(storeError("delete a thread's findings")),
    );

  const getBackoff: WorthKnowingStore["Service"]["getBackoff"] = sql<{
    readonly ignored_streak: number;
    readonly checks_to_skip: number;
  }>`
    SELECT ignored_streak, checks_to_skip FROM worth_knowing_projects
    WHERE project_id = ${BACKOFF_KEY}
  `.pipe(
    Effect.map((rows) => ({
      ignoredStreak: Number(rows[0]?.ignored_streak ?? 0),
      checksToSkip: Number(rows[0]?.checks_to_skip ?? 0),
    })),
    Effect.mapError(storeError("read the backoff")),
  );

  const setBackoff: WorthKnowingStore["Service"]["setBackoff"] = (state) =>
    sql`
      INSERT INTO worth_knowing_projects (project_id, ignored_streak, checks_to_skip)
      VALUES (${BACKOFF_KEY}, ${state.ignoredStreak}, ${state.checksToSkip})
      ON CONFLICT (project_id) DO UPDATE SET
        ignored_streak = excluded.ignored_streak,
        checks_to_skip = excluded.checks_to_skip
    `.pipe(Effect.asVoid, Effect.mapError(storeError("save the backoff")));

  return WorthKnowingStore.of({
    get,
    listThread,
    listRecent,
    listKnown,
    listOpenSummaries,
    insert,
    update,
    countMessagePast,
    deleteThread,
    getBackoff,
    setBackoff,
  });
});

export const layer = Layer.effect(WorthKnowingStore, make);
