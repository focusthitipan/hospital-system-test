import OpenAI   from 'openai';
import * as dotenv from 'dotenv';
import * as path   from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

// ─── OpenRouter Client ────────────────────────────────────────────────────────

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey:  process.env.OPENROUTER_API_KEY ?? '',
});

const MODEL = 'openai/gpt-4o-mini';   // ถูก รวดเร็ว รองรับภาษาไทย

// ─── Types ────────────────────────────────────────────────────────────────────

interface Duration {
  value:    number;
  unit:     'minute' | 'hour' | 'day' | 'week';
  raw_text: string;              // ข้อความต้นฉบับ เช่น "2 ชั่วโมง"
}

interface Symptom {
  description:       string;        // ชื่ออาการ เช่น "ปวดท้อง"
  qualifier:         string | null; // คำขยายอาการ เช่น "บิดๆ"
  location:          string | null; // ตำแหน่ง เช่น "ท้อง"
  duration:          Duration | null;
  severity:          string | null; // เฉพาะถ้าผู้ป่วยบอก เช่น "มาก"/"น้อย"
  onset_description: string | null; // วิธีเริ่มอาการ ถ้าบอก
}

// Schema บังคับ: ไม่มีฟิลด์ diagnosis / disease / condition เลย
// → AI ไม่มีที่ใส่การวินิจฉัย แม้อยากจะวินิจฉัยก็ใส่ไม่ได้
interface SymptomExtraction {
  source_text:          string;
  extracted_at:         string;           // ISO 8601
  symptoms:             Symptom[];
  recent_food:          string[] | null;
  recent_activities:    string[] | null;
  current_medications:  string[] | null;
  allergies_mentioned:  string[] | null;
  vital_signs: {
    temperature_celsius: number | null;
    pulse_rate:          number | null;
    systolic_bp:         number | null;
    diastolic_bp:        number | null;
  } | null;
  extraction_notes:     string[];         // ข้อสังเกตหรือส่วนที่ไม่ชัดเจน
}

// ─── System Prompt (Anti-Hallucination Design) ────────────────────────────────
//
// เทคนิคป้องกัน Hallucination 5 ชั้น:
//
//  ชั้นที่ 1 — Role Anchoring
//    บอกว่า AI คือ "extraction API" ไม่ใช่แพทย์ ให้สมองเข้าใจบทบาทที่แคบ
//
//  ชั้นที่ 2 — Schema Constraint (ไม่มีฟิลด์ diagnosis)
//    JSON Schema ที่ออกแบบมาไม่มีฟิลด์ diagnosis/disease/condition
//    AI ไม่มีที่ใส่การวินิจฉัย แม้จะ "รู้" คำตอบก็ตาม
//
//  ชั้นที่ 3 — Explicit Prohibition + Concrete Example
//    บอก "ห้าม" แล้วยกตัวอย่างเฉพาะเจาะจง
//    เช่น "กินส้มตำปูปลาร้า" → recent_food เท่านั้น ไม่ใช่ food poisoning
//
//  ชั้นที่ 4 — Null-First Policy
//    ถ้าไม่มีข้อมูลในข้อความ → null เสมอ ห้ามเดา
//
//  ชั้นที่ 5 — Application Validation (validateExtraction)
//    โค้ดฝั่ง Application ตรวจ output อีกชั้น
//    ถ้า AI แอบใส่ diagnosis key ก็จะถูกจับได้ก่อนบันทึก DB

const SYSTEM_PROMPT = `\
You are SYMPTOM_EXTRACTOR — a structured data extraction API for hospital intake systems.

## YOUR ROLE
Convert patient-reported text into structured JSON.
You are NOT a medical professional. You MUST NOT perform clinical reasoning or diagnosis.

## OUTPUT FORMAT
Return ONLY valid JSON. No markdown. No explanation. No extra text.
Use this exact schema:
{
  "source_text": "<original input unchanged>",
  "extracted_at": "<ISO 8601 UTC timestamp>",
  "symptoms": [
    {
      "description": "<symptom name>",
      "qualifier": "<quality adjective e.g. บิดๆ, or null>",
      "location": "<body part if stated, or null>",
      "duration": {
        "value": <number>,
        "unit": "<minute|hour|day|week>",
        "raw_text": "<exact phrase from source>"
      },
      "severity": "<null unless patient explicitly stated e.g. มาก/น้อย/ปานกลาง>",
      "onset_description": "<null unless patient described how it started>"
    }
  ],
  "recent_food": ["<food item>"] or null,
  "recent_activities": ["<activity>"] or null,
  "current_medications": ["<medication name>"] or null,
  "allergies_mentioned": ["<allergen>"] or null,
  "vital_signs": null,
  "extraction_notes": ["<note any ambiguity or missing info>"]
}

## ABSOLUTE PROHIBITIONS ❌
- NEVER add keys: diagnosis, disease, condition, assessment, impression,
  cause, etiology, differential, probable_cause, likely_cause, suspected
- NEVER infer medical conditions from symptoms or food
- NEVER add clinical interpretation of any kind
- NEVER extrapolate beyond what the patient explicitly stated

## EXTRACTION RULES
1. Extract ONLY what is EXPLICITLY stated in the source text
2. "กินส้มตำปูปลาร้า" → recent_food: ["ส้มตำปูปลาร้า"]
   ❌ NOT: cause, food poisoning, or any implication about why symptoms occurred
3. "ปวดท้องบิดๆ" → symptom description: "ปวดท้อง", qualifier: "บิดๆ"
   ❌ NOT: gastroenteritis, colitis, or any disease name
4. Duration "2 ชั่วโมง" → { value: 2, unit: "hour", raw_text: "2 ชั่วโมง" }
5. Missing severity, location, medication → always null (never guess)

## WHY THESE RULES
Hospital staff — not AI — perform clinical assessment.
This output feeds a database triage field only. Incorrect diagnosis causes patient harm.`;

// ─── Functions ────────────────────────────────────────────────────────────────

function buildUserPrompt(patientText: string): string {
  return `Extract structured data from the following patient-reported symptom text:

"${patientText}"

Return valid JSON only.`;
}

async function extractSymptoms(patientText: string): Promise<SymptomExtraction> {
  const response = await client.chat.completions.create({
    model:       MODEL,
    temperature: 0,            // ค่า 0 = deterministic, ลด hallucination จากความ "สร้างสรรค์"
    max_tokens:  1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: buildUserPrompt(patientText) },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';

  // ลอก ```json ... ``` ออกถ้า model ใส่มา
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed: SymptomExtraction;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Model returned invalid JSON:\n${raw}`);
  }

  return parsed;
}

// ─── Validation Layer (ชั้นป้องกัน Hallucination ที่ 5) ───────────────────────

const FORBIDDEN_KEYS = [
  'diagnosis', 'disease', 'condition', 'assessment', 'impression',
  'cause', 'etiology', 'differential', 'probable_cause', 'likely_cause',
  'suspected', 'possible', 'conclusion',
];

interface ValidationResult {
  valid:      boolean;
  violations: string[];
}

function validateExtraction(data: any, path = 'root'): ValidationResult {
  const violations: string[] = [];

  function scan(obj: any, p: string) {
    if (typeof obj !== 'object' || obj === null) return;
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_KEYS.some(f => lower.includes(f))) {
        violations.push(`Forbidden key at ${p}.${key} — AI attempted diagnosis`);
      }
      if (typeof obj[key] === 'string') {
        const val = obj[key].toLowerCase();
        if (FORBIDDEN_KEYS.some(f => val.includes(f))) {
          violations.push(`Diagnosis language in value at ${p}.${key}: "${obj[key]}"`);
        }
      }
      scan(obj[key], `${p}.${key}`);
    }
  }

  scan(data, path);

  if (!Array.isArray(data?.symptoms)) {
    violations.push('Missing or invalid symptoms array');
  }
  if (typeof data?.source_text !== 'string') {
    violations.push('Missing source_text');
  }

  return { valid: violations.length === 0, violations };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`);
}

async function runTests(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === 'your_key_here') {
    console.error('ERROR: กรุณาใส่ OPENROUTER_API_KEY ใน .env ก่อนรัน');
    process.exit(1);
  }

  const INPUT = 'ปวดท้องบิดๆ มา 2 ชั่วโมง กินส้มตำปูปลาร้ามา';

  console.log('═'.repeat(64));
  console.log('Q6: Symptom to Structured Data — Anti-Hallucination Demo');
  console.log('═'.repeat(64));
  console.log(`\nInput: "${INPUT}"\n`);
  console.log('Calling model via OpenRouter...\n');

  // ── Test 1: Extraction ────────────────────────────────────────────────────
  console.log('─'.repeat(64));
  console.log('Test 1: Extract symptoms to JSON');
  console.log('─'.repeat(64));

  const result = await extractSymptoms(INPUT);
  console.log('\nExtracted JSON:');
  console.log(JSON.stringify(result, null, 2));

  // ── Test 2: Symptom fields ────────────────────────────────────────────────
  console.log('\n─'.repeat(64).slice(1));
  console.log('Test 2: Symptom fields extracted correctly');
  console.log('─'.repeat(64));

  const sym = result.symptoms?.[0];
  assert(result.symptoms.length >= 1,            'at least one symptom found');
  assert(sym?.description?.includes('ปวดท้อง'), `description contains "ปวดท้อง": "${sym?.description}"`);
  assert(sym?.qualifier === 'บิดๆ',             `qualifier = "บิดๆ": "${sym?.qualifier}"`);
  assert(sym?.duration?.value === 2,             `duration.value = 2: ${sym?.duration?.value}`);
  assert(sym?.duration?.unit  === 'hour',        `duration.unit = "hour": "${sym?.duration?.unit}"`);

  // ── Test 3: Recent food extracted ─────────────────────────────────────────
  console.log('\n─'.repeat(64).slice(1));
  console.log('Test 3: Recent food extracted (not a diagnosis)');
  console.log('─'.repeat(64));

  assert(Array.isArray(result.recent_food),           `recent_food is array: ${JSON.stringify(result.recent_food)}`);
  assert(result.recent_food!.length >= 1,             'at least one food item found');
  assert(result.recent_food!.some(f => f.includes('ส้มตำ')),
    `food contains "ส้มตำ": ${JSON.stringify(result.recent_food)}`);

  // ── Test 4: Severity = null (not stated by patient) ──────────────────────
  console.log('\n─'.repeat(64).slice(1));
  console.log('Test 4: Severity = null (patient did not state severity)');
  console.log('─'.repeat(64));

  assert(sym?.severity === null,
    `severity is null (patient did not say "มาก/น้อย"): ${sym?.severity}`);
  assert(result.current_medications === null,
    `medications = null (not mentioned): ${result.current_medications}`);
  assert(result.allergies_mentioned === null,
    `allergies = null (not mentioned): ${result.allergies_mentioned}`);

  // ── Test 5: Anti-Hallucination — no diagnosis keys ────────────────────────
  console.log('\n─'.repeat(64).slice(1));
  console.log('Test 5: Anti-Hallucination — output must NOT contain diagnosis');
  console.log('─'.repeat(64));

  const validation = validateExtraction(result);
  if (validation.valid) {
    assert(true, 'No forbidden keys found — AI did not self-diagnose');
    assert(!JSON.stringify(result).toLowerCase().includes('food poison'),
      'No "food poison" language in output');
    assert(!JSON.stringify(result).toLowerCase().includes('อาหารเป็นพิษ'),
      'No "อาหารเป็นพิษ" in output');
    assert(!JSON.stringify(result).toLowerCase().includes('gastro'),
      'No "gastroenteritis" in output');
  } else {
    console.log('  FAIL — Hallucination detected:');
    validation.violations.forEach(v => console.log(`    ⚠  ${v}`));
  }

  // ── Test 6: Source text preserved ────────────────────────────────────────
  console.log('\n─'.repeat(64).slice(1));
  console.log('Test 6: Source text preserved unchanged');
  console.log('─'.repeat(64));

  assert(result.source_text === INPUT,
    `source_text matches input: "${result.source_text}"`);

  // ── Anti-Hallucination Technique Summary ─────────────────────────────────
  console.log('\n' + '═'.repeat(64));
  console.log('Anti-Hallucination Techniques Used');
  console.log('═'.repeat(64));
  console.log(`
  1. Role Anchoring      — System prompt frames AI as "extraction API",
                           not a doctor. Limits scope of reasoning.

  2. Schema Constraint   — SymptomExtraction interface has NO diagnosis/
                           disease/condition field. AI has no place to
                           put a diagnosis even if it tries.

  3. Explicit Examples   — Prompt shows EXACTLY what NOT to do:
                           "กินส้มตำปูปลาร้า" → recent_food only,
                           NOT food poisoning. Removes ambiguity.

  4. Null-First Policy   — Default is null for any missing data.
                           AI is forbidden from guessing or assuming.

  5. App-Level Validation— validateExtraction() scans all JSON keys
                           and values for forbidden words (diagnosis,
                           disease, condition, etc.) after the API call.
                           Acts as a catch-all safety net before DB write.

  6. Temperature = 0     — Deterministic output, reduces "creative"
                           additions that cause hallucination.
`);

  console.log('=== Done ===');
}

runTests().catch(err => { console.error(err); process.exit(1); });
