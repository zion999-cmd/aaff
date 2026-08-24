// P0010.1 Post-Productization REPAIR — minimal Output / WorkItem API.
//
// Five endpoints, no transport, no engine, no approval flow:
//   GET    /api/situations/:id/outputs      — list all WorkItems
//   POST   /api/situations/:id/outputs      — create a new WorkItem
//   PATCH  /api/situations/:id/outputs/:oid — transition status (ready →
//                                              delivered → acknowledged →
//                                              closed)
//   GET    /api/outputs                     — cross-situation collection
//   GET    /api/outputs/:oid                — single Output (with provenance)
//
// The WorkItem is persisted inside the Learning Context's `body.outputs[]`
// JSON column. No SQL migration. No new table. Reuses the existing
// `learning_contexts` row.
//
// P0010.1 REPAIR-5 boundary changes (per user audit 2026-08-22):
//   - Removed `POST /api/situations/:id/outputs/mark-delivered`. The
//     old "open the page = delivered" side effect is no longer valid.
//     `delivered` now means only that the Agent has surfaced the item
//     to the Workspace; the transition is driven by the Operator, not
//     by page load. The collection endpoint does NOT auto-transition.
//   - `currentSituation` (from `/api/outputs/:oid`) is read from
//     `ctx.investigation.*` (canonical InvestigationSchema), not from
//     top-level `ctx.*`.
//   - `provenance` (real Human / Evidence / Knowledge facts only) is
//     included in the response; the UI must NOT render categories
//     that have no supporting record.
//
// Strict boundaries (NOT INCLUDED):
//   - No Action execution (the Agent never executes business operations).
//   - No external transport (Feishu / WeCom / Email / Telegram — out of scope).
//   - No Event Bus, no wake engine, no scheduler (out of scope).
//   - No approval flow (the Operator's lifecycle is the only path).
//   - `WorkItem.closed` does NOT close the Situation.
//
// See `context/p0010_1_productization_baseline.md` Schema Blockers
// (SB-1 / SB-4) — `evidence` resultRef kind is aspirational and will return
// "unavailable" until P0011 Evidence Identity lands.

import { Router } from 'express';
import type { Database as Db } from 'better-sqlite3';
import { z } from 'zod';
import { nowIso } from '#shared/utils/time.js';
import {
  readLearningContextBody,
  writeLearningContextBody,
} from '#app/experience/learning-context-helpers.js';
import {
  WorkItemSchema,
  WorkItemStatusSchema,
  type WorkItem,
  type WorkItemStatus,
} from '#shared/schemas/output.js';

// ---- Helpers ----

const ok = (res: any, data: unknown, meta?: Record<string, unknown>) => {
  res.json({ success: true, data, ...(meta ? { meta } : {}) });
};
const fail = (res: any, status: number, error: string) => {
  res.status(status).json({ success: false, error });
};

/** Generate a stable-looking id without bringing in uuid (matches the
 *  convention used by `human_interventions` and the demo seed). */
const genOutputId = (): string =>
  `out_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ---- Routes ----

export const outputsRouter = (db: Db): Router => {
  const router = Router();

  // ── List ───────────────────────────────────────────────
  router.get('/situations/:id/outputs', (req, res) => {
    const situationId = req.params.id;
    const read = readLearningContextBody(db, situationId);
    if (!read) return ok(res, []);
    ok(res, read.ctx.outputs);
  });

  // ── Create ─────────────────────────────────────────────
  // Body: { type, content, resultRef? }
  // Server assigns: outputId, situationId, status='ready', createdAt
  const CreateOutputBody = z.object({
    type: WorkItemSchema.shape.type,
    content: z.string().min(1).max(2000),
    resultRef: WorkItemSchema.shape.resultRef.optional(),
  });

  router.post('/situations/:id/outputs', (req, res) => {
    const situationId = req.params.id;
    let body: z.infer<typeof CreateOutputBody>;
    try {
      body = CreateOutputBody.parse(req.body);
    } catch (e) {
      return fail(res, 400, e instanceof Error ? e.message : 'invalid body');
    }
    const read = readLearningContextBody(db, situationId);
    if (!read) return fail(res, 404, 'Learning context not found for this situation.');

    const now = nowIso();
    const output: WorkItem = {
      outputId: genOutputId(),
      situationId,
      type: body.type,
      status: 'ready',
      resultRef: body.resultRef,
      content: body.content,
      createdAt: now,
    };
    read.ctx.outputs = [...(read.ctx.outputs as WorkItem[]), output];
    writeLearningContextBody(db, situationId, read.ctx);
    ok(res, output);
  });

  // ── Patch (status transition) ──────────────────────────
  // Body: { status }
  //
  // P0010.1 REPAIR-6: the WorkItemSchema's `status` enum IS the only
  // state machine. PATCH must enforce forward-only transitions
  // (skip-ahead allowed, rollback rejected). The canonical order is:
  //
  //   ready → delivered → acknowledged → closed
  //
  // Concretely:
  //   ready        → delivered / acknowledged / closed  (any forward)
  //   delivered    → acknowledged / closed            (any forward)
  //   acknowledged → closed                            (only forward)
  //   closed       → nothing                           (terminal)
  //
  // Rollback attempts (closed → ready, acknowledged → delivered,
  // delivered → ready, etc.) are 400. `WorkItem.closed` does NOT
  // close the Situation; the PATCH only mutates this single WorkItem.
  const STATUS_ORDER: Readonly<Record<WorkItemStatus, number>> = Object.freeze({
    ready: 0,
    delivered: 1,
    acknowledged: 2,
    closed: 3,
  });
  const PatchOutputBody = z.object({
    status: WorkItemStatusSchema,
  });

  router.patch('/situations/:id/outputs/:oid', (req, res) => {
    const situationId = req.params.id;
    const outputId = req.params.oid;
    let body: z.infer<typeof PatchOutputBody>;
    try {
      body = PatchOutputBody.parse(req.body);
    } catch (e) {
      return fail(res, 400, e instanceof Error ? e.message : 'invalid body');
    }
    const read = readLearningContextBody(db, situationId);
    if (!read) return fail(res, 404, 'Learning context not found for this situation.');

    const outputs = read.ctx.outputs as WorkItem[];
    const idx = outputs.findIndex((o) => o.outputId === outputId);
    if (idx === -1) return fail(res, 404, 'Output not found.');

    const prev = outputs[idx];
    if (!prev) return fail(res, 404, 'Output not found.');

    // P0010.1 REPAIR-6: forward-only transition guard. `closed` is
    // terminal; anything else must not move backwards along the
    // canonical order. Same-status PATCH is also a no-op rejection
    // (it would set acknowledgedAt/closedAt again, which is dishonest
    // — a re-acknowledgement is not a new event).
    if (body.status === prev.status) {
      return fail(res, 400, `Status is already '${prev.status}'. No transition needed.`);
    }
    if (STATUS_ORDER[body.status] < STATUS_ORDER[prev.status]) {
      return fail(res, 400,
        `Status rollback rejected: cannot move '${prev.status}' → '${body.status}'. ` +
        `WorkItem transitions are forward-only along the canonical order ` +
        `(ready → delivered → acknowledged → closed); rollback is not allowed.`,
      );
    }

    const next: WorkItem = { ...prev, status: body.status };
    if (body.status === 'acknowledged' && !prev.acknowledgedAt) {
      next.acknowledgedAt = nowIso();
    }
    if (body.status === 'closed' && !prev.closedAt) {
      next.closedAt = nowIso();
    }
    read.ctx.outputs = outputs.map((o, i) => (i === idx ? next : o));
    writeLearningContextBody(db, situationId, read.ctx);
    ok(res, next);
  });

  // P0010.1 REPAIR-5: the previous "mark all ready as delivered on
  // Situation detail open" convenience endpoint has been REMOVED.
  // Opening the Workspace does NOT advance a WorkItem to 'delivered'.
  // Status transitions are Operator-driven via PATCH; the collection
  // endpoint does NOT auto-transition either. There is no
  // side-effect-on-page-load anywhere in this slice.

  // ── Single Output (cross-situation, read-only) ────────────────────
  // P0010.1 Output Workspace v0: GET /api/outputs/:oid
  // Fetches one WorkItem from across all learning_contexts, attaching
  // the source situation context (entity / description / type) so the
  // Output Detail view can render "来源 Situation" without a second
  // call. Does NOT attach generation-time judgment snapshot (the
  // schema does not currently record it) — the surface shows the
  // *current* situation judgment with a clear "current state" note.
  // 404 if no matching outputId is found.
  router.get('/outputs/:oid', (req, res) => {
    const outputId = req.params.oid;
    if (!outputId) return fail(res, 400, 'Missing outputId.');

    const rows = db.prepare(
      'SELECT lc.situation_id AS situation_id, s.entity_id, s.entity_name, s.entity_type, s.entity_platform, s.description, s.tags, lc.body AS body ' +
      'FROM learning_contexts lc ' +
      'LEFT JOIN situations s ON s.situation_id = lc.situation_id',
    ).all() as Array<{
      situation_id: string;
      entity_id: string | null;
      entity_name: string | null;
      entity_type: string | null;
      entity_platform: string | null;
      description: string | null;
      tags: string | null;
      body: string;
    }>;

    for (const r of rows) {
      let ctx: Record<string, unknown>;
      try {
        ctx = JSON.parse(r.body ?? '{}');
      } catch {
        continue;
      }
      if (!Array.isArray(ctx.outputs)) continue;
      const hit = (ctx.outputs as WorkItem[]).find((o) => o && o.outputId === outputId);
      if (!hit) continue;
      // P0010.1 REPAIR-5: pull the current judgment / recommendation
      // from the canonical InvestigationSchema location, which is
      // `ctx.investigation.*` (NOT `ctx.*` at the top level). The
      // previous implementation read `ctx.currentUnderstanding` and
      // `ctx.recommendation` from the top level — which is not where
      // the canonical schema stores them, so on real data both were
      // empty / undefined.
      const investigation = (ctx.investigation && typeof ctx.investigation === 'object')
        ? (ctx.investigation as Record<string, unknown>) : null;
      const recommendation = investigation && investigation.recommendation
        && typeof investigation.recommendation === 'object'
          ? (investigation.recommendation as Record<string, unknown>) : null;
      const understanding = investigation && typeof investigation.currentUnderstanding === 'string'
        ? investigation.currentUnderstanding : '';
      const judgment = investigation && typeof investigation.judgment === 'string'
        ? investigation.judgment : '';
      const stopReason = investigation && typeof investigation.stopReason === 'string'
        ? investigation.stopReason : '';
      const recText = recommendation && typeof recommendation.recommendation === 'string'
        ? recommendation.recommendation : '';
      const rationale = recommendation && typeof recommendation.rationale === 'string'
        ? recommendation.rationale : '';
      let tags: string[] = [];
      try {
        const parsed = r.tags ? JSON.parse(r.tags) : [];
        if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
      } catch { /* keep [] */ }

      // P0010.1 REPAIR-5: real provenance facts only. We do NOT invent
      // categories. Each kind is included in the response ONLY when
      // there is actual evidence (Human intervention, recorded
      // Evidence, etc.). Without this, the UI would render 4 fixed
      // tags even when nothing is referenced — exactly the "fake
      // citation" the rules forbid.
      //
      // P0010.1 REPAIR-6: only `findings[].evidenceRefs[]` drives
      // `hasEvidence` / `evidenceLabels[]`. The previous version
      // merged `investigation.knownEvidence[]` into the same bucket,
      // which is wrong: `knownEvidence` is free-text investigation
      // notes and may contain human guidance, knowledge rules, or
      // any other prose. Treating it as Evidence mis-categorizes the
      // source. The honest answer is: if the text isn't actually a
      // reference to a recorded Evidence artifact, do NOT tag it
      // `[证据]`. We keep `knownEvidence` reachable via the
      // canonical investigation surface (Layer 2 of the Situation
      // detail / `/api/situations/:id` response) — but it does not
      // become provenance here.
      const humanInterventions = Array.isArray(ctx.humanInterventions)
        ? (ctx.humanInterventions as Array<{ interventionId?: string; type?: string; timestamp?: string; summary?: string }>)
        : [];
      const findings = investigation && Array.isArray(investigation.findings)
        ? (investigation.findings as Array<{ evidenceRefs?: string[]; question?: string; answer?: string }>)
        : [];
      const evidenceRefs = findings.flatMap((f) => Array.isArray(f.evidenceRefs) ? f.evidenceRefs : []);

      const provenance: {
        hasHuman: boolean;
        humanInterventions: Array<{ interventionId: string; type: string; timestamp: string; summary: string }>;
        hasEvidence: boolean;
        evidenceLabels: string[];
        hasKnowledge: boolean;
        knowledgeLabels: string[];
      } = {
        hasHuman: humanInterventions.length > 0,
        humanInterventions: humanInterventions.map((h) => ({
          interventionId: h.interventionId || '',
          type: h.type || '',
          timestamp: h.timestamp || '',
          summary: h.summary || '',
        })),
        hasEvidence: evidenceRefs.length > 0,
        evidenceLabels: evidenceRefs.filter((s) => typeof s === 'string' && s.length > 0),
        // Knowledge: there is no first-class record in this slice; the
        // only honest answer is "not present" — we never synthesize.
        hasKnowledge: false,
        knowledgeLabels: [],
      };

      return ok(res, {
        ...hit,
        situation: {
          situationId: r.situation_id,
          entityId: r.entity_id,
          entityName: r.entity_name,
          entityType: r.entity_type,
          entityPlatform: r.entity_platform,
          description: r.description,
          tags,
        },
        currentSituation: {
          understanding,
          judgment,
          stopReason,
          recommendation: recText,
          recommendationRationale: rationale,
          // Surface that this is the *current* state, not a generation-time
          // snapshot. The schema does not snapshot at output creation.
          snapshotAvailable: false,
        },
        // Real provenance only; the UI must NOT render categories
        // that have no supporting record.
        provenance,
      });
    }
    return fail(res, 404, 'Output not found.');
  });

  // ── Collection (cross-situation, read-only) ───────────────────
  // P0010.1 REPAIR-3: a single read-only endpoint that lists ALL outputs
  // across all situations, with optional `status` filter. The data
  // source is the existing `learning_contexts.body.outputs[]` JSON
  // column — we do NOT copy, duplicate, or create a second Output
  // Store. The endpoint joins with `situations` ONLY to surface
  // operator-facing context (entityName, entityType, platform) so the
  // Workspace "工作输出" page can show "来自: 祁门红茶旗舰店 (sit_human_demo)".
  //
  // Query params:
  //   status  — optional: ready | delivered | acknowledged | closed
  //   limit   — optional: 1..500, default 200
  //   offset  — optional: default 0
  //
  // Strict boundaries (NOT INCLUDED):
  //   - Read-only. No POST / PATCH / DELETE here.
  //   - Opening the page does NOT change status to 'delivered'.
  //   - No transport, no Hermes bridge, no Email/Feishu/WeCom.
  //   - Does not affect Situation.lifecycle.
  router.get('/outputs', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    // Validate the status filter against the enum (unknown status → 400).
    if (status && !WorkItemStatusSchema.options.includes(status as WorkItemStatus)) {
      return fail(res, 400, `Invalid status filter: ${status}. Allowed: ${WorkItemStatusSchema.options.join(', ')}`);
    }

    // Pull every learning_context that has a non-empty outputs[].
    // We keep this as a single SQL pass with JSON parsing in JS so we
    // do not need to migrate the schema. A bounded set (production cap
    // is small — typical team has <1k learning contexts).
    const rows = db.prepare(
      'SELECT lc.situation_id AS situation_id, s.entity_id, s.entity_name, s.entity_type, s.entity_platform, s.description, lc.body AS body ' +
      'FROM learning_contexts lc ' +
      'LEFT JOIN situations s ON s.situation_id = lc.situation_id',
    ).all() as Array<{
      situation_id: string;
      entity_id: string | null;
      entity_name: string | null;
      entity_type: string | null;
      entity_platform: string | null;
      description: string | null;
      body: string;
    }>;

    const items: Array<WorkItem & {
      situation: {
        situationId: string;
        entityId: string | null;
        entityName: string | null;
        entityType: string | null;
        entityPlatform: string | null;
        description: string | null;
      };
    }> = [];
    for (const r of rows) {
      let ctx: Record<string, unknown>;
      try {
        ctx = JSON.parse(r.body ?? '{}');
      } catch {
        continue;
      }
      if (!Array.isArray(ctx.outputs)) continue;
      for (const raw of ctx.outputs as WorkItem[]) {
        if (!raw || typeof raw !== 'object') continue;
        if (status && raw.status !== status) continue;
        items.push({
          ...raw,
          situation: {
            situationId: r.situation_id,
            entityId: r.entity_id,
            entityName: r.entity_name,
            entityType: r.entity_type,
            entityPlatform: r.entity_platform,
            description: r.description,
          },
        });
      }
    }

    // Stable ordering: most recent first, then by situationId for determinism.
    items.sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime();
      const tb = new Date(b.createdAt || 0).getTime();
      if (ta !== tb) return tb - ta;
      return a.situationId.localeCompare(b.situationId);
    });

    const total = items.length;
    const sliced = items.slice(offset, offset + limit);
    return ok(res, sliced, { total, limit, offset });
  });

  return router;
};
