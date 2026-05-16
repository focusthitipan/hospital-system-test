"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const openai_1 = __importDefault(require("openai"));
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
dotenv.config({ path: path.join(__dirname, '.env') });
// ============================================================
// ข้อ 7: Smart Drug Interaction Checker
// ============================================================
//
//  Architecture Diagram
//  ════════════════════════════════════════════════════════
//
//  ┌───────────────────────────────────────────────────────┐
//  │   Doctor / Pharmacist UI  (drug order form)           │
//  └──────────────────────────┬────────────────────────────┘
//                             │  checkInteraction(drugA, drugB, ip)
//                             ▼
//  ┌───────────────────────────────────────────────────────┐
//  │  STEP 1 — Rule-Based DB Lookup  [AUTHORITATIVE]       │
//  │  PostgreSQL: drug_interactions table                  │
//  │  Human-curated, peer-reviewed data                    │
//  │                                                       │
//  │  contraindicated ──→ BLOCK  ◄─ AI cannot override    │
//  │  major           ──→ BLOCK  ◄─ AI cannot override    │
//  │  moderate/minor  ──→ continue to Step 2               │
//  │  not found       ──→ continue to Step 2               │
//  └──────────────────────────┬────────────────────────────┘
//                             │
//                             ▼
//  ┌───────────────────────────────────────────────────────┐
//  │  STEP 2 — AI Analysis Layer  (OpenRouter / GPT-4o)   │
//  │                                                       │
//  │  System prompt enforces:                              │
//  │  • Structured JSON output (no free-text)              │
//  │  • Mandatory confidence_score 0.0–1.0                 │
//  │  • "Safer to admit uncertainty than to guess"         │
//  │  • Sources must be cited                              │
//  └──────────────────────────┬────────────────────────────┘
//                             │
//                             ▼
//  ┌───────────────────────────────────────────────────────┐
//  │  STEP 3 — Safety Decision Engine (Human-in-the-Loop) │
//  │                                                       │
//  │  DB blocked             → outcome: blocked            │
//  │  AI confidence ≥ 0.80  → outcome: auto_advisory       │
//  │  AI confidence 0.50–0.79→ outcome: requires_review   │
//  │                           pharmacist must approve     │
//  │  AI confidence < 0.50  → outcome: escalated           │
//  │                           blocked until human reviews │
//  └──────────────┬───────────────────────┬───────────────┘
//                 │                       │
//                 ▼                       ▼
//  ┌──────────────────────┐  ┌───────────────────────────────┐
//  │  Audit Log (DB)      │  │  Human-in-the-Loop            │
//  │  Immutable (trigger) │  │  notifyForReview()            │
//  │  Every check logged  │  │  Pharmacist alert channel     │
//  │  3-year PDPA retain  │  │  (requires_review / escalated)│
//  └──────────────────────┘  └───────────────────────────────┘
// ─── DB Connection ────────────────────────────────────────────────────────────
const pool = new pg_1.Pool({
    host: '192.168.1.80', user: 'postgres',
    password: 'P@ssw0rd', database: 'postgres', max: 10,
});
// ─── AI Client ────────────────────────────────────────────────────────────────
const ai = new openai_1.default({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
});
const MODEL = 'openai/gpt-4o-mini';
// ─── System Prompt ────────────────────────────────────────────────────────────
//
//  Safety design ใน Prompt มีสี่ชั้น:
//    1. Role Anchoring: "decision support tool" ไม่ใช่ผู้ตัดสินใจ
//    2. Confidence Scale: นิยาม 0.0–1.0 ชัดเจน บังคับรายงานความไม่แน่ใจ
//    3. Uncertainty Principle: "safer to admit uncertainty than to guess"
//    4. Forbidden fields: ห้าม diagnosis, prognosis, treatment plan
const SYSTEM_PROMPT = `\
You are DRUG_INTERACTION_ANALYZER — a medical safety AI providing decision support.

## ROLE
Analyze whether two drugs have a known pharmacological interaction.
You are a SUPPORT TOOL ONLY. Final decisions are made by licensed pharmacists and physicians.

## OUTPUT FORMAT
Return ONLY valid JSON. No markdown. No explanation outside the JSON:
{
  "interaction_found": boolean,
  "severity": "contraindicated" | "major" | "moderate" | "minor" | "none",
  "mechanism": "<pharmacological mechanism, or null>",
  "clinical_effect": "<expected outcome for patient, or null>",
  "recommendation": "<safety recommendation for prescriber>",
  "confidence_score": <number 0.0–1.0>,
  "requires_human_review": <boolean>,
  "uncertainty_reason": "<reason if unsure, or null>",
  "sources_cited": ["<source 1>", "..."]
}

## CONFIDENCE SCORING  (mandatory — determines Human-in-the-Loop routing)
- 0.90–1.00 : Multiple high-quality RCTs or clinical guidelines confirm this interaction
- 0.70–0.89 : Established in pharmacokinetic studies or multiple reliable case series
- 0.50–0.69 : Limited evidence; case reports only; conflicting literature
              → MUST set requires_human_review: true
- 0.00–0.49 : Insufficient data; unknown drug; post-training cutoff; conflicting evidence
              → MUST set requires_human_review: true

## UNCERTAINTY PRINCIPLE  ⚠ CRITICAL SAFETY RULE
A FALSE NEGATIVE (missing a real interaction) can cause patient death.
It is ALWAYS SAFER to:
  ✓ Admit you don't know → low confidence_score
  ✓ Recommend human review
  ✗ Provide a confident but wrong answer

## UNKNOWN DRUG RULE  ⚠⚠⚠ THIS OVERRIDES EVERYTHING ELSE
Before analyzing, ask yourself: "Is this a real pharmaceutical drug I have seen in clinical literature?"
If you are NOT 100% certain that BOTH drug names are real, approved drugs:
  • Set confidence_score to 0.05
  • Set requires_human_review to true
  • Set uncertainty_reason: "One or both drug names are unrecognized — not found in training data"
  • Set interaction_found to false
  • Set severity to "none"
DO NOT guess. DO NOT assume a fictional name is a variant of a real drug.
DO NOT invent interactions for drugs you do not recognize.

## PROHIBITIONS ❌
- NEVER fabricate drug interaction data
- NEVER provide patient diagnosis or prognosis
- NEVER suggest a treatment plan`;
// ─── Step 1: DB Lookup ────────────────────────────────────────────────────────
async function checkDatabase(drugA, drugB) {
    // normalize: เรียงตัวอักษรเพื่อให้ (A,B) กับ (B,A) เป็น row เดียวกัน
    const [lo, hi] = [drugA, drugB].map(d => d.toLowerCase()).sort();
    const r = await pool.query(`
    SELECT severity, mechanism, clinical_effect, recommendation
    FROM drug_interactions
    WHERE drug_lo = $1 AND drug_hi = $2
  `, [lo, hi]);
    return r.rows[0] ?? null;
}
// ─── Step 2: AI Analysis ─────────────────────────────────────────────────────
async function analyzeWithAI(drugA, drugB) {
    const response = await ai.chat.completions.create({
        model: MODEL,
        temperature: 0, // deterministic = ลด hallucination
        max_tokens: 600,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Check drug interaction between: "${drugA}" and "${drugB}"\n\nReturn JSON only.` },
        ],
    });
    const raw = response.choices[0]?.message?.content ?? '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
}
function makeDecision(dbResult, ai) {
    // ── Priority 1: DB ตัดสินเสมอสำหรับ contraindicated / major ──────────────
    if (dbResult?.severity === 'contraindicated')
        return {
            decision: 'blocked',
            message: `[DB] CONTRAINDICATED: ${dbResult.clinical_effect}. ${dbResult.recommendation}`,
            routed: false,
        };
    if (dbResult?.severity === 'major')
        return {
            decision: 'blocked',
            message: `[DB] MAJOR INTERACTION: ${dbResult.clinical_effect}. ${dbResult.recommendation}`,
            routed: false,
        };
    // ── Priority 2: ไม่มีใน DB → ใช้ AI + confidence routing ─────────────────
    const c = ai.confidence_score;
    // confidence ต่ำมาก = AI ไม่รู้จักยา → escalate ก่อนตรวจ interaction_found
    // "ไม่พบ interaction ด้วย confidence 5%" ≠ "ปลอดภัย"
    if (c < 0.50)
        return {
            decision: 'escalated',
            message: `[AI confidence ${(c * 100).toFixed(0)}% — ESCALATED] ${ai.uncertainty_reason ?? 'Insufficient data'}. Blocked pending pharmacist review.`,
            routed: true,
        };
    if (!ai.interaction_found)
        return {
            decision: 'safe',
            message: `[AI confidence ${(c * 100).toFixed(0)}%] No significant interaction identified.`,
            routed: false,
        };
    if (c >= 0.80)
        return {
            decision: 'auto_advisory',
            message: `[AI confidence ${(c * 100).toFixed(0)}%] ${ai.severity.toUpperCase()}: ${ai.clinical_effect}. ${ai.recommendation}`,
            routed: false,
        };
    if (c >= 0.50)
        return {
            decision: 'requires_review',
            message: `[AI confidence ${(c * 100).toFixed(0)}% — REQUIRES PHARMACIST REVIEW] ${ai.recommendation}`,
            routed: true,
        };
    return {
        decision: 'escalated',
        message: `[AI confidence ${(c * 100).toFixed(0)}% — ESCALATED: insufficient evidence] ${ai.uncertainty_reason ?? 'Unknown drug or limited data'}. Blocked pending pharmacist review.`,
        routed: true,
    };
}
// ─── Human-in-the-Loop Notification ──────────────────────────────────────────
function notifyForReview(checkId, drugA, drugB, outcome, confidence) {
    const urgency = outcome === 'escalated' ? '🔴 URGENT' : '🟡 REVIEW NEEDED';
    console.log(`  [NOTIFY] ${urgency} — Check #${checkId}`);
    console.log(`           Drugs: ${drugA} + ${drugB}`);
    console.log(`           AI confidence: ${(confidence * 100).toFixed(0)}%`);
    console.log(`           Action required: Pharmacist must review before prescription proceeds`);
}
// ─── Audit Log ────────────────────────────────────────────────────────────────
async function logCheck(entry) {
    const r = await pool.query(`
    INSERT INTO interaction_checks_log
      (drug_a, drug_b, db_severity, ai_confidence, decision, safety_message)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING check_id
  `, [entry.drugA, entry.drugB, entry.dbSeverity, entry.aiConfidence,
        entry.decision, entry.safetyMessage]);
    return r.rows[0].check_id;
}
// ─── Main Entry Point ─────────────────────────────────────────────────────────
async function checkInteraction(drugA, drugB) {
    const [lo, hi] = [drugA, drugB].sort();
    // Step 1 — DB
    const dbResult = await checkDatabase(lo, hi);
    // Step 2 — AI: ข้ามถ้า DB block แล้ว (contraindicated/major)
    const dbBlocked = dbResult?.severity === 'contraindicated' || dbResult?.severity === 'major';
    let aiResult = null;
    if (!dbBlocked) {
        try {
            aiResult = await analyzeWithAI(lo, hi);
        }
        catch (e) {
            // ถ้า AI ล้มเหลว → conservative fallback: route ไป pharmacist เสมอ
            aiResult = {
                interaction_found: true, severity: 'major',
                mechanism: null, clinical_effect: 'AI analysis failed',
                recommendation: 'AI unavailable — route to pharmacist immediately',
                confidence_score: 0, requires_human_review: true,
                uncertainty_reason: `AI error: ${e.message}`, sources_cited: [],
            };
        }
    }
    // Step 3 — Decision
    const safeAI = aiResult ?? {
        interaction_found: false, severity: 'none',
        mechanism: null, clinical_effect: null,
        recommendation: 'Blocked by database rule',
        confidence_score: 1, requires_human_review: false,
        uncertainty_reason: null, sources_cited: [],
    };
    const { decision, message, routed } = makeDecision(dbResult, safeAI);
    // Audit log
    const checkId = await logCheck({
        drugA, drugB,
        dbSeverity: dbResult?.severity ?? null,
        aiConfidence: aiResult?.confidence_score ?? null,
        decision, safetyMessage: message,
    });
    // Human-in-the-Loop notification
    if (routed && aiResult) {
        notifyForReview(checkId, drugA, drugB, decision, aiResult.confidence_score);
    }
    return {
        drug_a: drugA, drug_b: drugB,
        db_severity: dbResult?.severity ?? null,
        ai_analysis: aiResult,
        decision, safety_message: message,
        routed_to_human: routed,
        check_id: checkId,
    };
}
// ─── Schema + Seed Data ───────────────────────────────────────────────────────
async function setup() {
    await pool.query(`
    DROP TABLE IF EXISTS interaction_checks_log CASCADE;
    DROP TABLE IF EXISTS drug_interactions       CASCADE;
  `);
    await pool.query(`
    -- ตาราง known interactions (human-curated, peer-reviewed)
    -- drug_lo/drug_hi: lowercase sorted alphabetically เพื่อ normalize (A,B)=(B,A)
    CREATE TABLE drug_interactions (
      interaction_id  SERIAL       PRIMARY KEY,
      drug_lo         VARCHAR(100) NOT NULL,  -- alphabetically first
      drug_hi         VARCHAR(100) NOT NULL,  -- alphabetically second
      severity        VARCHAR(20)  NOT NULL
        CONSTRAINT chk_sev CHECK (severity IN ('contraindicated','major','moderate','minor')),
      mechanism       TEXT,
      clinical_effect TEXT,
      recommendation  TEXT,
      source          VARCHAR(200),
      UNIQUE (drug_lo, drug_hi)
    );

    -- Immutable audit log — trigger ป้องกัน UPDATE/DELETE
    CREATE TABLE interaction_checks_log (
      check_id        BIGSERIAL    PRIMARY KEY,
      drug_a          VARCHAR(100) NOT NULL,
      drug_b          VARCHAR(100) NOT NULL,
      db_severity     VARCHAR(20),
      ai_confidence   NUMERIC(4,3),
      decision        VARCHAR(30)  NOT NULL,
      safety_message  TEXT         NOT NULL,
      checked_at      TIMESTAMP    NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION fn_protect_check_log()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE: interaction_checks_log ห้าม UPDATE/DELETE';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_protect_check_log
    BEFORE UPDATE OR DELETE ON interaction_checks_log
    FOR EACH ROW EXECUTE FUNCTION fn_protect_check_log();
  `);
    // Known interactions — sorted alphabetically per pair
    await pool.query(`
    INSERT INTO drug_interactions
      (drug_lo, drug_hi, severity, mechanism, clinical_effect, recommendation, source)
    VALUES
      ('aspirin','warfarin',
       'major',
       'Both agents inhibit platelet aggregation and coagulation cascade',
       'Significantly increased bleeding risk; GI hemorrhage risk x2–3',
       'Avoid concurrent use unless cardiology consultation confirms benefit outweighs risk',
       'FDA Drug Interaction Database 2024'),

      ('phenelzine','tramadol',
       'contraindicated',
       'Tramadol inhibits serotonin/norepinephrine reuptake; MAOIs prevent monoamine degradation',
       'Serotonin syndrome: hyperthermia, seizures, cardiovascular collapse — potentially fatal',
       'ABSOLUTELY CONTRAINDICATED — 14-day washout required after stopping MAOI',
       'FDA Black Box Warning; Micromedex 2024'),

      ('amiodarone','simvastatin',
       'major',
       'Amiodarone inhibits CYP3A4, reducing simvastatin metabolism significantly',
       'Elevated simvastatin plasma levels → rhabdomyolysis, acute renal failure',
       'Simvastatin dose must not exceed 20 mg/day; consider pravastatin instead',
       'FDA Safety Communication 2011; AHA Guidelines 2022'),

      ('metformin','contrast_dye',
       'moderate',
       'Iodinated contrast can cause acute kidney injury; impaired renal clearance raises metformin levels',
       'Lactic acidosis risk in patients with renal impairment',
       'Hold metformin 48h before and after contrast procedure; check eGFR before resuming',
       'ACR Manual on Contrast Media 2023')
  `);
}
// ─── Tests ────────────────────────────────────────────────────────────────────
function assert(cond, msg) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`);
}
async function runTests() {
    await setup();
    console.log('Schema + known interactions loaded.\n');
    // ── Test 1: Contraindicated pair → DB blocks immediately ──────────────────
    console.log('═'.repeat(64));
    console.log('Test 1: Phenelzine + Tramadol → CONTRAINDICATED (DB blocks, AI not consulted)');
    console.log('═'.repeat(64));
    const t1 = await checkInteraction('Phenelzine', 'Tramadol');
    console.log(`  Decision:  ${t1.decision}`);
    console.log(`  Message:   ${t1.safety_message}`);
    assert(t1.decision === 'blocked', 'decision = blocked');
    assert(t1.db_severity === 'contraindicated', 'db_severity = contraindicated');
    assert(t1.ai_analysis === null, 'AI not consulted (DB is authoritative)');
    assert(!t1.routed_to_human, 'no human routing needed (DB handles it)');
    // ── Test 2: Major interaction → DB blocks ─────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 2: Warfarin + Aspirin → MAJOR (DB blocks)');
    console.log('═'.repeat(64));
    const t2 = await checkInteraction('Warfarin', 'Aspirin');
    console.log(`  Decision:  ${t2.decision}`);
    console.log(`  Message:   ${t2.safety_message}`);
    assert(t2.decision === 'blocked', 'decision = blocked');
    assert(t2.db_severity === 'major', 'db_severity = major');
    // ── Test 3: NOT in DB — AI analysis, high confidence ─────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 3: Fluoxetine + Tramadol → NOT in DB (AI analyzes — serotonin syndrome risk)');
    console.log('═'.repeat(64));
    const t3 = await checkInteraction('Fluoxetine', 'Tramadol');
    console.log(`  Decision:    ${t3.decision}`);
    console.log(`  AI severity: ${t3.ai_analysis?.severity}`);
    console.log(`  AI confidence: ${((t3.ai_analysis?.confidence_score ?? 0) * 100).toFixed(0)}%`);
    console.log(`  AI message:  ${t3.safety_message}`);
    assert(t3.db_severity === null, 'not in DB (AI-only)');
    assert(t3.decision !== 'safe' || (t3.ai_analysis?.confidence_score ?? 0) >= 0.80, `decision appropriate for AI confidence ${((t3.ai_analysis?.confidence_score ?? 0) * 100).toFixed(0)}%`);
    // ── Test 4: NOT in DB — AI moderate confidence → Human-in-the-Loop ───────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 4: Clopidogrel + Omeprazole → NOT in DB (AI moderate confidence → review)');
    console.log('═'.repeat(64));
    const t4 = await checkInteraction('Clopidogrel', 'Omeprazole');
    console.log(`  Decision:    ${t4.decision}`);
    console.log(`  AI confidence: ${((t4.ai_analysis?.confidence_score ?? 0) * 100).toFixed(0)}%`);
    console.log(`  Routed to human: ${t4.routed_to_human}`);
    console.log(`  Message: ${t4.safety_message}`);
    assert(t4.db_severity === null, 'not in DB');
    assert(['auto_advisory', 'requires_review', 'escalated'].includes(t4.decision), `decision is advisory/review/escalated: ${t4.decision}`);
    // ── Test 5: Unknown/fictional drug → AI low confidence → Escalated ────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 5: Warfarin + Zeldoximab (fictional) → AI uncertain → ESCALATED');
    console.log('═'.repeat(64));
    const t5 = await checkInteraction('Warfarin', 'Zeldoximab');
    console.log(`  Decision:    ${t5.decision}`);
    console.log(`  AI confidence: ${((t5.ai_analysis?.confidence_score ?? 0) * 100).toFixed(0)}%`);
    console.log(`  Uncertainty: ${t5.ai_analysis?.uncertainty_reason}`);
    console.log(`  Routed to human: ${t5.routed_to_human}`);
    assert(t5.db_severity === null, 'not in DB');
    assert((t5.ai_analysis?.confidence_score ?? 1) < 0.50, 'AI confidence < 50% for unknown drug');
    assert(t5.decision === 'escalated', 'decision = escalated');
    assert(t5.routed_to_human, 'routed to pharmacist');
    // ── Test 6: Audit log is immutable ────────────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 6: Audit log is immutable (trigger blocks UPDATE)');
    console.log('═'.repeat(64));
    try {
        await pool.query(`UPDATE interaction_checks_log SET decision = 'safe' WHERE check_id = 1`);
        assert(false, 'should have thrown');
    }
    catch (e) {
        assert(e.message.includes('AUDIT_LOG_IMMUTABLE'), `trigger blocked UPDATE: "${e.message}"`);
    }
    // ── Test 7: Full audit report ─────────────────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 7: Audit Report — all checks this session');
    console.log('═'.repeat(64));
    const logs = await pool.query(`
    SELECT check_id,
           drug_a,
           drug_b,
           COALESCE(db_severity, '-')               AS db,
           COALESCE((ai_confidence*100)::INT::TEXT || '%', '-') AS ai_conf,
           decision,
           TO_CHAR(checked_at,'HH24:MI:SS')         AS time
    FROM interaction_checks_log
    ORDER BY check_id
  `);
    console.table(logs.rows);
    console.log('\n=== Done ===');
    await pool.end();
}
runTests().catch(err => { console.error(err); process.exit(1); });
