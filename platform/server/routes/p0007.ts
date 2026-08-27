// P0007.2 Routes — Situation API + Intervention API.
// Thin HTTP adapters over SQLite. No business logic — all semantics in schemas.

import { Router } from 'express';
import type { Database as Db } from 'better-sqlite3';
import { nowIso } from '#shared/utils/time.js';
import { HumanInterventionSchema, SituationSchema } from '#shared/schemas/learning-context.js';
import { loadSituation, recordInterventionInLearningContext, loadLearningContext } from '#app/experience/learning-context-producer.js';
// P0010.2.x — single source of truth for the operator-facing state.
// Both /api/situations and /api/situations/:id route through this reducer
// so the Feed and Detail can never disagree.
import { reduce, reduceForFeed } from '#app/workspace/presentation-state.js';

// ---- Helpers ----

const ok = (res: any, data: unknown, meta?: Record<string, unknown>) => {
  res.json({ success: true, data, ...(meta ? { meta } : {}) });
};
const fail = (res: any, status: number, error: string) => {
  res.status(status).json({ success: false, error });
};

/**
 * P0010.1 Final Repair — Area D: derive the business status of a Situation
 * from its persisted Investigation state. Pure — no LLM, no fuzzy text
 * match. The decision tree is the single source of truth (mirrored by the
 * server unit test in `tests/unit/routes/derive-investigation-status.test.ts`).
 *
 *   pending         → no investigation yet (auto-recovery will pick it up)
 *   investigating   → a turn is in progress (status marker persisted before run)
 *   failed          → last turn timed out/failed (recoverable — no silent loss)
 *   observing       → stopReason = observe
 *   needs_human     → stopReason ∈ {missing_capability, ask_human}
 *                     OR stopReason = judgment AND
 *                        recommendation.humanNeeded[] is non-empty
 *   judgment_ready  → stopReason = judgment (with empty or absent humanNeeded)
 *
 * Note: the prior version of this function flipped status to `needs_human`
 * whenever the agent's prose mentioned "人工核验" / "人工确认" / "无法获取" as
 * passing text. That was a heuristic, not a contract — it mis-triggered on
 * cases where the agent was acknowledging past human input, and missed the
 * real blocking signal: a populated `recommendation.humanNeeded[]`. This
 * version only reads structured fields.
 */
export type SituationInvestigationStatus =
  | 'pending'
  | 'investigating'
  | 'failed'
  | 'observing'
  | 'needs_human'
  | 'judgment_ready';

type InvestigationLike = {
  status?: string;
  stopReason?: string;
  judgment?: string;
  currentUnderstanding?: string;
  recommendation?: { humanNeeded?: unknown } | null;
} | null;

export const deriveInvestigationStatus = (
  inv: InvestigationLike,
): SituationInvestigationStatus => {
  if (!inv) return 'pending';
  if (inv.status === 'investigating') return 'investigating';
  if (inv.status === 'failed') return 'failed';
  const stop = inv.stopReason ?? '';
  if (stop === 'observe') return 'observing';
  if (stop === 'missing_capability' || stop === 'ask_human') return 'needs_human';
  if (stop === 'judgment') {
    const rec = inv.recommendation;
    if (rec && Array.isArray(rec.humanNeeded) && rec.humanNeeded.length > 0) {
      return 'needs_human';
    }
    return 'judgment_ready';
  }
  return 'judgment_ready';
};

// ---- Routes ----

export const p0007Router = (db: Db): Router => {
  const router = Router();

  // ── Situation API ────────────────────────────────────────

  // GET /api/situations — list recent situations.
  // P0010.1: each situation carries its Agent investigation summary so the
  // Workspace list can show business status (uninvestigated / observing /
  // judgment_ready / needs_human) without entering the Detail.
  router.get('/situations', (_req, res) => {
    try {
      const rows = db.prepare(
        `SELECT s.*, COUNT(i.intervention_id) as intervention_count,
                lc.body as lc_body
         FROM situations s
         LEFT JOIN human_interventions i ON s.situation_id = i.situation_id
         LEFT JOIN learning_contexts lc ON s.situation_id = lc.situation_id
         GROUP BY s.situation_id
         ORDER BY s.observed_at DESC
         LIMIT 50`,
      ).all() as Record<string, unknown>[];

      const situations = rows.map((r) => {
        const lcBody = (() => {
          try { return JSON.parse(String(r.lc_body ?? '{}')); } catch { return {}; }
        })();
        const inv = (lcBody.investigation ?? null) as {
          status?: string;
          stopReason?: string;
          judgment?: string;
          nextQuestion?: string;
          currentUnderstanding?: string;
          findings?: unknown[];
          recommendation?: { humanNeeded?: unknown } | null;
          consecutiveFailures?: number;
          blockedEmittedAt?: string | null;
          maxConsecutiveFailures?: number;
          startedAt?: string;
          updatedAt?: string;
          hypotheses?: unknown[];
        } | null;
        // The list endpoint cannot N+1 over `human_interventions` per
        // row; we use a single EXISTS() query that returns 0/1 in O(1)
        // per row. This is the only intervention-derived fact the Feed
        // reducer needs that the SQL JOIN does not already provide.
        const hasAccept = (db
          .prepare(
            `SELECT EXISTS(
               SELECT 1 FROM human_interventions
               WHERE situation_id = ? AND type = 'decision'
                 AND json_extract(content, '$.decision') = 'accept'
             ) as v`,
          )
          .get(String(r.situation_id)) as { v: number }).v === 1;
        // P0010.2.x — run the SAME reducer as the Detail page so Feed and
        // Detail cannot disagree on the same Situation.
        const feed = reduceForFeed({
          situation: {
            situationId: String(r.situation_id),
            lifecycle: r.lifecycle as 'open' | 'partial' | 'mature',
            createdAt: String(r.created_at),
            updatedAt: String(r.updated_at),
            description: String(r.description ?? ''),
            type: String(r.type ?? ''),
            entity: {
              id: r.entity_id as string,
              type: r.entity_type as string,
              name: r.entity_name as string | undefined,
              platform: r.entity_platform as string | undefined,
            },
            temporal: {
              observedAt: r.observed_at as string,
            },
          },
          learningContext: lcBody && Object.keys(lcBody).length > 0 ? lcBody : null,
          // The list endpoint only has `interventionCount` (from the SQL
          // JOIN above). The reducer accepts `interventions: []` and we
          // surface the count separately as `interventionCount`. This
          // keeps the list query O(1) per row.
          interventions: [],
          // Override hasAcceptedDecision with the O(1) EXISTS query above.
          // The reducer cannot know about it without the full rows, so
          // we patch it post-hoc.
          now: nowIso(),
        });
        return {
          situationId: r.situation_id,
          domain: r.domain,
          type: r.type,
          entity: { id: r.entity_id, type: r.entity_type, name: r.entity_name, platform: r.entity_platform },
          temporal: { observedAt: r.observed_at, windowStart: r.window_start, windowEnd: r.window_end },
          description: r.description,
          tags: JSON.parse(String(r.tags ?? '[]')),
          lifecycle: r.lifecycle,
          interventionCount: r.intervention_count,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          // P0010.2.x — single source of truth for the operator-facing
          // state. The legacy `investigation: { status, ... }` block is
          // preserved for back-compat with the existing Feed JS, but new
          // UI MUST read `presentation` / `headline` / `shortLabel`.
          presentation: feed.presentation,
          headline: feed.headline,
          shortLabel: feed.shortLabel,
          judgmentPreview: feed.judgmentPreview,
          hasAcceptedDecision: hasAccept,
          presentationRevision: feed.presentationRevision,
          // Legacy field — kept so the existing Feed JS does not break
          // during migration. New consumers MUST use `presentation`.
          investigation: inv ? {
            status: deriveInvestigationStatus(inv),
            stopReason: inv.stopReason ?? null,
            judgment: inv.judgment ?? null,
            nextQuestion: inv.nextQuestion ?? null,
            findingsCount: (inv.findings ?? []).length,
          } : null,
        };
      });

      ok(res, situations);
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to list situations');
    }
  });

  // GET /api/situations/:id — full situation detail.
  router.get('/situations/:id', (req, res) => {
    try {
      const situationId = req.params['id'];
      if (!situationId) { fail(res, 400, 'Missing situation ID'); return; }

      const row = db.prepare('SELECT * FROM situations WHERE situation_id = ?').get(situationId) as Record<string, unknown> | undefined;
      if (!row) { fail(res, 404, 'Situation not found'); return; }

      // Also fetch interventions
      const interventions = db.prepare(
        'SELECT * FROM human_interventions WHERE situation_id = ? ORDER BY created_at ASC',
      ).all(situationId) as Record<string, unknown>[];

      // P0010.1 REPAIR-2: include learningContext (carries outputs[]) in the
      // first-pass response so the Output/WorkItem section can render
      // synchronously without a second-pass API call. Without this, the
      // section was only populated via a follow-up /outputs + mark-delivered
      // call that could fail silently, leaving the section empty.
      const lcRow = db.prepare(
        'SELECT body, lifecycle, created_at, updated_at FROM learning_contexts WHERE situation_id = ?',
      ).get(situationId) as { body: string; lifecycle: string; created_at: string; updated_at: string } | undefined;
      const learningContext = lcRow ? (() => {
        try {
          const parsed = JSON.parse(lcRow.body);
          return {
            ...parsed,
            lifecycle: lcRow.lifecycle,
            createdAt: lcRow.created_at,
            updatedAt: lcRow.updated_at,
          };
        } catch {
          return { raw: lcRow.body, parseError: true };
        }
      })() : null;

      // P0010.2.x — compute the single Workspace Presentation snapshot
      // BEFORE composing the response, so the route returns it alongside
      // the raw fields (the raw fields stay for back-compat with non-
      // Workspace consumers; the Workspace UI MUST read only this).
      const workspacePresentation = reduce({
        situation: {
          situationId: String(row.situation_id),
          lifecycle: row.lifecycle as 'open' | 'partial' | 'mature',
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          description: String(row.description ?? ''),
          type: String(row.type ?? ''),
          entity: {
            id: row.entity_id as string,
            type: row.entity_type as string,
            name: row.entity_name as string | undefined,
            platform: row.entity_platform as string | undefined,
          },
          temporal: {
            observedAt: row.observed_at as string,
          },
        },
        learningContext: learningContext ?? null,
        interventions: interventions.map((i: Record<string, unknown>) => ({
          interventionId: String(i.intervention_id),
          situationId: String(i.situation_id),
          actor: { id: String(i.actor_id ?? ''), role: String(i.actor_role ?? '') },
          type: i.type as 'response' | 'correction' | 'context_supplement' | 'decision',
          content: JSON.parse(String(i.content ?? '{}')),
          summary: String(i.summary ?? ''),
          reviewId: (i.review_id as string | undefined) ?? undefined,
          actionId: (i.action_id as string | undefined) ?? undefined,
          respondsToActivityIds: JSON.parse(String(i.responds_to_activity_ids ?? '[]')),
          _legacySource: ((i.legacy_source as string | undefined) ?? 'none') as
            | 'legacy_review'
            | 'legacy_feedback'
            | 'none',
          timestamp: String(i.created_at),
        })),
        now: nowIso(),
      });

      const situation = {
        situationId: row.situation_id,
        domain: row.domain,
        type: row.type,
        entity: { id: row.entity_id, type: row.entity_type, name: row.entity_name, platform: row.entity_platform },
        temporal: { observedAt: row.observed_at, windowStart: row.window_start, windowEnd: row.window_end },
        description: row.description,
        tags: JSON.parse(String(row.tags ?? '[]')),
        lifecycle: row.lifecycle,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        interventions: interventions.map((i: Record<string, unknown>) => ({
          interventionId: i.intervention_id,
          situationId: i.situation_id,
          actor: { id: i.actor_id, role: i.actor_role },
          type: i.type,
          content: JSON.parse(String(i.content ?? '{}')),
          summary: i.summary,
          respondsToActivityIds: JSON.parse(String(i.responds_to_activity_ids ?? '[]')),
          reviewId: i.review_id,
          actionId: i.action_id,
          legacySource: i.legacy_source,
          timestamp: i.created_at,
        })),
        // P0010.1 REPAIR-2: outputs[] lives on learning_contexts.body; expose
        // it (and the rest of the LearningContext) at the top level so the
        // Operator UI can render Agent deliverables in the FIRST pass.
        outputs: (learningContext && Array.isArray(learningContext.outputs))
          ? learningContext.outputs
          : [],
        learningContext: learningContext,
        // P0010.2.x — Workspace Presentation Output is the single source
        // of truth for the operator-facing state. The Workspace UI MUST
        // read this; the raw fields above are kept for back-compat only.
        workspacePresentation,
      };

      ok(res, situation);
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to load situation');
    }
  });

  // POST /api/situations — create a new situation from observation data.
  router.post('/situations', (req, res) => {
    try {
      const parsed = SituationSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, `Invalid situation: ${parsed.error.message}`);
        return;
      }
      const s = parsed.data;
      const now = nowIso();

      db.prepare(
        `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
           observed_at, window_start, window_end, description, tags, lifecycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.situationId, s.domain, s.type,
        s.entity.id, s.entity.type, s.entity.name ?? null, s.entity.platform ?? null,
        s.temporal.observedAt, s.temporal.windowStart ?? null, s.temporal.windowEnd ?? null,
        s.description, JSON.stringify(s.tags ?? []), 'open', now, now,
      );

      ok(res, { situationId: s.situationId, createdAt: now }, { status: 'created' });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to create situation');
    }
  });

  // ── Intervention API ─────────────────────────────────────

  // GET /api/situations/:id/interventions — list interventions for a situation.
  router.get('/situations/:id/interventions', (req, res) => {
    try {
      const situationId = req.params['id'];
      if (!situationId) { fail(res, 400, 'Missing situation ID'); return; }

      const rows = db.prepare(
        'SELECT * FROM human_interventions WHERE situation_id = ? ORDER BY created_at ASC',
      ).all(situationId) as Record<string, unknown>[];

      const interventions = rows.map((i) => ({
        interventionId: i.intervention_id,
        situationId: i.situation_id,
        actor: { id: i.actor_id, role: i.actor_role },
        type: i.type,
        content: JSON.parse(String(i.content ?? '{}')),
        summary: i.summary,
        respondsToActivityIds: JSON.parse(String(i.responds_to_activity_ids ?? '[]')),
        reviewId: i.review_id,
        actionId: i.action_id,
        legacySource: i.legacy_source,
        timestamp: i.created_at,
      }));

      ok(res, interventions);
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to list interventions');
    }
  });

  // POST /api/situations/:id/interventions — record a new intervention.
  router.post('/situations/:id/interventions', (req, res) => {
    try {
      const situationId = req.params['id'];
      if (!situationId) { fail(res, 400, 'Missing situation ID'); return; }

      // Verify situation exists
      const situation = db.prepare('SELECT situation_id FROM situations WHERE situation_id = ?').get(situationId);
      if (!situation) { fail(res, 404, 'Situation not found'); return; }

      const body = { ...req.body, situationId };
      const parsed = HumanInterventionSchema.safeParse(body);
      if (!parsed.success) {
        fail(res, 400, `Invalid intervention: ${parsed.error.message}`);
        return;
      }

      const i = parsed.data;
      const now = nowIso();

      db.prepare(
        `INSERT INTO human_interventions (intervention_id, situation_id, actor_id, actor_role,
           type, content, summary, responds_to_activity_ids, review_id, action_id, legacy_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        i.interventionId, i.situationId, i.actor.id, i.actor.role,
        i.type, JSON.stringify(i.content), i.summary,
        JSON.stringify(i.respondsToActivityIds), i.reviewId ?? null, i.actionId ?? null,
        i._legacySource, now,
      );

      // Update situation lifecycle if this is the first intervention
      const interventionCount = (db.prepare(
        'SELECT COUNT(*) as cnt FROM human_interventions WHERE situation_id = ?',
      ).get(situationId) as { cnt: number }).cnt;

      if (interventionCount === 1) {
        db.prepare(
          'UPDATE situations SET lifecycle = ?, updated_at = ? WHERE situation_id = ?',
        ).run('partial', now, situationId);
      }

      // Record the intervention into the situation's Learning Context (INSERT or
      // UPDATE). This is Fabric's experience delivery layer — Memory stays with Hermes.
      const situationFull = loadSituation(db, situationId);
      if (situationFull) {
        recordInterventionInLearningContext(db, situationFull, i);
      }

      ok(res, { interventionId: i.interventionId, createdAt: now }, { status: 'created' });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to record intervention');
    }
  });

  // GET /api/situations/:id/learning-context — the situation's Learning Context
  // (Fabric's experience delivery layer, consumed by Hermes). 404 when not yet created.
  router.get('/situations/:id/learning-context', (req, res) => {
    try {
      const situationId = req.params['id'];
      if (!situationId) { fail(res, 400, 'Missing situation ID'); return; }
      const ctx = loadLearningContext(db, situationId);
      if (!ctx) { fail(res, 404, 'Learning context not found'); return; }
      ok(res, ctx);
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to load learning context');
    }
  });

  return router;
};
