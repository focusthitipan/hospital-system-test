import { Pool, PoolClient } from 'pg';

// ============================================================
// ข้อ 4: Drug Allergy & Safety Design
// ============================================================

const pool = new Pool({
  host: '192.168.1.80', user: 'postgres',
  password: 'P@ssw0rd', database: 'postgres', max: 10,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity      = 'mild' | 'moderate' | 'severe' | 'anaphylaxis';
type DoctorRole    = 'standard' | 'senior' | 'head';
type PrescStatus   = 'active' | 'cancelled' | 'completed';

interface AllergyAlert {
  allergyId:           number;
  drugId:              number;
  drugName:            string;
  severity:            Severity;
  reaction:            string;
  isClassAllergy:      boolean;
  matchedClass:        string | null;
  requiredOverrideRole: DoctorRole;
}

// ─── Business Rule: ระดับที่ต้องการในการ Override ───────────────────────────
//
//   mild / moderate  → standard doctor หรือสูงกว่า
//   severe           → senior doctor หรือสูงกว่า
//   anaphylaxis      → department head เท่านั้น
//
const REQUIRED_OVERRIDE_ROLE: Record<Severity, DoctorRole> = {
  mild:        'standard',
  moderate:    'standard',
  severe:      'senior',
  anaphylaxis: 'head',
};

const ROLE_RANK: Record<DoctorRole, number> = {
  standard: 1,
  senior:   2,
  head:     3,
};

function canOverride(doctorRole: DoctorRole, required: DoctorRole): boolean {
  return ROLE_RANK[doctorRole] >= ROLE_RANK[required];
}

// ─── Schema ───────────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS override_logs   CASCADE;
    DROP TABLE IF EXISTS prescriptions   CASCADE;
    DROP TABLE IF EXISTS drug_allergies  CASCADE;
    DROP TABLE IF EXISTS drugs           CASCADE;
    DROP TABLE IF EXISTS doctors         CASCADE;
    DROP TABLE IF EXISTS patients        CASCADE;
  `);

  await pool.query(`
    -- ผู้ป่วย
    CREATE TABLE patients (
      patient_id  SERIAL        PRIMARY KEY,
      name        VARCHAR(100)  NOT NULL
    );

    -- แพทย์ พร้อม role กำหนดสิทธิ์ Override
    CREATE TABLE doctors (
      doctor_id  SERIAL       PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      role       VARCHAR(20)  NOT NULL
        CONSTRAINT chk_doctor_role CHECK (role IN ('standard','senior','head'))
    );

    -- คลังยา พร้อม drug_class สำหรับตรวจ cross-reactivity
    CREATE TABLE drugs (
      drug_id      SERIAL        PRIMARY KEY,
      drug_name    VARCHAR(200)  NOT NULL,
      drug_class   VARCHAR(100),   -- e.g. 'penicillin', 'nsaid', 'sulfonamide'
      generic_name VARCHAR(200)
    );

    -- ประวัติแพ้ยาของผู้ป่วย
    -- แพ้ได้สองแบบ: แพ้ยาเฉพาะ (drug_id) หรือแพ้ทั้ง class (drug_class)
    CREATE TABLE drug_allergies (
      allergy_id   SERIAL       PRIMARY KEY,
      patient_id   INT          NOT NULL REFERENCES patients(patient_id),
      drug_id      INT          REFERENCES drugs(drug_id),   -- NULL ถ้าแพ้ทั้ง class
      drug_class   VARCHAR(100),                              -- NULL ถ้าแพ้ยาเฉพาะเม็ด
      severity     VARCHAR(20)  NOT NULL
        CONSTRAINT chk_allergy_severity CHECK (severity IN ('mild','moderate','severe','anaphylaxis')),
      reaction     TEXT,
      recorded_by  INT          NOT NULL REFERENCES doctors(doctor_id),
      recorded_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
      is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
      -- ต้องระบุอย่างน้อยหนึ่งอย่าง: drug_id หรือ drug_class
      CONSTRAINT chk_allergy_target
        CHECK (drug_id IS NOT NULL OR drug_class IS NOT NULL),
      -- ไม่ให้บันทึกแพ้ยาซ้ำสำหรับผู้ป่วยคนเดียวกัน
      CONSTRAINT uq_patient_drug    UNIQUE (patient_id, drug_id),
      CONSTRAINT uq_patient_class   UNIQUE (patient_id, drug_class)
    );

    -- บันทึก Override ทุกครั้งที่แพทย์ข้ามคำเตือน (Audit Trail)
    CREATE TABLE override_logs (
      override_id    SERIAL    PRIMARY KEY,
      patient_id     INT       NOT NULL REFERENCES patients(patient_id),
      drug_id        INT       NOT NULL REFERENCES drugs(drug_id),
      allergy_id     INT       NOT NULL REFERENCES drug_allergies(allergy_id),
      overridden_by  INT       NOT NULL REFERENCES doctors(doctor_id),
      override_reason TEXT     NOT NULL,
      overridden_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- ใบสั่งยา
    -- override_id: ถ้า NOT NULL แสดงว่าแพทย์ได้รับอนุมัติ override แล้ว
    CREATE TABLE prescriptions (
      prescription_id SERIAL      PRIMARY KEY,
      patient_id      INT         NOT NULL REFERENCES patients(patient_id),
      drug_id         INT         NOT NULL REFERENCES drugs(drug_id),
      prescribed_by   INT         NOT NULL REFERENCES doctors(doctor_id),
      prescribed_at   TIMESTAMP   NOT NULL DEFAULT NOW(),
      dosage          VARCHAR(100),
      duration_days   INT,
      status          VARCHAR(20) NOT NULL DEFAULT 'active'
        CONSTRAINT chk_presc_status CHECK (status IN ('active','cancelled','completed')),
      override_id     INT         REFERENCES override_logs(override_id)
    );
  `);

  // ─── Trigger: บังคับตรวจแพ้ยาก่อน INSERT / UPDATE ทุกครั้ง ──────────────
  //
  // ทำงานที่ฝั่ง Database → ป้องกันได้แม้มีระบบอื่นเชื่อมต่อโดยตรง
  //
  // ข้อความ error ใช้ format "ALLERGY_BLOCK|allergyId|severity|reaction|matchType"
  // เพื่อให้ Application parse แล้วแสดง Alert ที่ถูกต้องได้

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_check_drug_allergy()
    RETURNS TRIGGER AS $$
    DECLARE
      v_drug_class  VARCHAR(100);
      v_allergy_id  INT;
      v_severity    VARCHAR(20);
      v_reaction    TEXT;
    BEGIN
      -- ถ้ามี override_id ที่ผ่านการอนุมัติแล้ว → ข้ามการตรวจ
      -- แต่ตรวจว่า override นั้น match กับ patient+drug จริงก่อน
      IF NEW.override_id IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM override_logs
          WHERE override_id = NEW.override_id
            AND patient_id  = NEW.patient_id
            AND drug_id     = NEW.drug_id
        ) THEN
          RAISE EXCEPTION 'INVALID_OVERRIDE: override_id % ไม่ตรงกับ patient/drug', NEW.override_id;
        END IF;
        RETURN NEW;
      END IF;

      -- 1. ตรวจแพ้ยาเฉพาะตัว (specific drug allergy)
      SELECT allergy_id, severity, COALESCE(reaction,'')
      INTO   v_allergy_id, v_severity, v_reaction
      FROM   drug_allergies
      WHERE  patient_id = NEW.patient_id
        AND  drug_id    = NEW.drug_id
        AND  is_active  = TRUE
      LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'ALLERGY_BLOCK|%|%|%|specific',
          v_allergy_id, v_severity, v_reaction;
      END IF;

      -- 2. ตรวจแพ้ทั้ง drug class (cross-reactivity)
      SELECT drug_class INTO v_drug_class
      FROM   drugs WHERE drug_id = NEW.drug_id;

      IF v_drug_class IS NOT NULL THEN
        SELECT allergy_id, severity, COALESCE(reaction,'')
        INTO   v_allergy_id, v_severity, v_reaction
        FROM   drug_allergies
        WHERE  patient_id  = NEW.patient_id
          AND  drug_class  = v_drug_class
          AND  is_active   = TRUE
        LIMIT 1;

        IF FOUND THEN
          RAISE EXCEPTION 'ALLERGY_BLOCK|%|%|%|class:%',
            v_allergy_id, v_severity, v_reaction, v_drug_class;
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_check_drug_allergy ON prescriptions;
    CREATE TRIGGER trg_check_drug_allergy
    BEFORE INSERT OR UPDATE ON prescriptions
    FOR EACH ROW EXECUTE FUNCTION fn_check_drug_allergy();
  `);

  // ─── Sample Data ──────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO patients (patient_id, name) VALUES
      (1, 'Alice'),
      (2, 'Bob');

    INSERT INTO doctors (doctor_id, name, role) VALUES
      (1, 'Dr. Standard', 'standard'),
      (2, 'Dr. Senior',   'senior'),
      (3, 'Dr. Head',     'head');

    INSERT INTO drugs (drug_id, drug_name, drug_class, generic_name) VALUES
      (1, 'Amoxicillin 500mg',  'penicillin', 'amoxicillin'),
      (2, 'Ampicillin 250mg',   'penicillin', 'ampicillin'),
      (3, 'Ibuprofen 400mg',    'nsaid',      'ibuprofen'),
      (4, 'Naproxen 500mg',     'nsaid',      'naproxen'),
      (5, 'Paracetamol 500mg',  NULL,         'paracetamol'),
      (6, 'Ciprofloxacin 500mg','quinolone',  'ciprofloxacin');
  `);
}

// ─── Application Functions ────────────────────────────────────────────────────

/** บันทึกประวัติแพ้ยาให้ผู้ป่วย */
async function recordAllergy(
  patientId:    number,
  allergy:      { drugId?: number; drugClass?: string; severity: Severity; reaction: string },
  recordedBy:   number,
): Promise<number> {
  const r = await pool.query<{ allergy_id: number }>(
    `INSERT INTO drug_allergies (patient_id, drug_id, drug_class, severity, reaction, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING allergy_id`,
    [patientId, allergy.drugId ?? null, allergy.drugClass ?? null,
     allergy.severity, allergy.reaction, recordedBy],
  );
  return r.rows[0].allergy_id;
}

/** ตรวจว่ายาที่จะสั่งมีความเสี่ยงกับผู้ป่วยหรือไม่ — ใช้ก่อน prescribeDrug */
async function checkAllergyAlerts(patientId: number, drugId: number): Promise<AllergyAlert[]> {
  const r = await pool.query<{
    allergy_id: number; drug_id: number | null; drug_name: string;
    severity: Severity; reaction: string; drug_class: string | null; matched_class: string | null;
  }>(`
    SELECT
      da.allergy_id,
      da.drug_id,
      d_prescribed.drug_name,
      da.severity,
      COALESCE(da.reaction, '') AS reaction,
      da.drug_class,
      CASE WHEN da.drug_id IS NULL THEN da.drug_class ELSE NULL END AS matched_class
    FROM drug_allergies da
    JOIN drugs d_prescribed ON d_prescribed.drug_id = $2
    WHERE da.patient_id = $1
      AND da.is_active  = TRUE
      AND (
        da.drug_id   = $2                        -- แพ้ยาตัวนี้โดยตรง
        OR da.drug_class = d_prescribed.drug_class  -- แพ้ทั้ง class นี้
      )
  `, [patientId, drugId]);

  return r.rows.map(row => ({
    allergyId:           row.allergy_id,
    drugId:              drugId,
    drugName:            row.drug_name,
    severity:            row.severity,
    reaction:            row.reaction,
    isClassAllergy:      row.drug_id === null,
    matchedClass:        row.matched_class,
    requiredOverrideRole: REQUIRED_OVERRIDE_ROLE[row.severity],
  }));
}

/**
 * สั่งยา — ถ้าผู้ป่วยแพ้จะ throw AllergyError
 * ถ้าต้องการข้ามคำเตือน ให้เรียก overrideAndPrescribe แทน
 */
async function prescribeDrug(
  patientId:    number,
  drugId:       number,
  dosage:       string,
  durationDays: number,
  doctorId:     number,
): Promise<number> {
  try {
    const r = await pool.query<{ prescription_id: number }>(
      `INSERT INTO prescriptions (patient_id, drug_id, dosage, duration_days, prescribed_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING prescription_id`,
      [patientId, drugId, dosage, durationDays, doctorId],
    );
    return r.rows[0].prescription_id;
  } catch (err: any) {
    // Trigger ส่ง error message ในรูป "ALLERGY_BLOCK|id|severity|reaction|type"
    if (err.message?.startsWith('ALLERGY_BLOCK')) {
      const [, allergyId, severity, reaction, matchType] = err.message.split('|');
      throw new AllergyError({
        allergyId:   Number(allergyId),
        severity:    severity as Severity,
        reaction,
        isClassAllergy: matchType.startsWith('class:'),
        matchedClass:   matchType.startsWith('class:') ? matchType.split(':')[1] : null,
        requiredOverrideRole: REQUIRED_OVERRIDE_ROLE[severity as Severity],
      });
    }
    throw err;
  }
}

/**
 * Override คำเตือนแพ้ยาแล้วสั่งยา
 *
 * Workflow:
 *   1. ตรวจว่าแพทย์มีสิทธิ์ Override severity นั้นหรือไม่
 *   2. บันทึก override_log (Audit Trail)
 *   3. INSERT prescription พร้อม override_id
 *
 * ทั้งหมดอยู่ใน Transaction เดียว → atomic
 */
async function overrideAndPrescribe(
  patientId:    number,
  drugId:       number,
  allergyId:    number,
  dosage:       string,
  durationDays: number,
  doctorId:     number,
  reason:       string,
): Promise<{ prescriptionId: number; overrideId: number }> {

  // ── 1. โหลดข้อมูลแพทย์และ allergy ──────────────────────────────────────
  const [docRes, allergyRes] = await Promise.all([
    pool.query<{ role: DoctorRole }>('SELECT role FROM doctors WHERE doctor_id = $1', [doctorId]),
    pool.query<{ severity: Severity; patient_id: number }>(
      'SELECT severity, patient_id FROM drug_allergies WHERE allergy_id = $1', [allergyId]
    ),
  ]);

  if (docRes.rows.length === 0) throw new Error(`Doctor ${doctorId} not found`);
  if (allergyRes.rows.length === 0) throw new Error(`Allergy ${allergyId} not found`);
  if (allergyRes.rows[0].patient_id !== patientId)
    throw new Error(`Allergy ${allergyId} does not belong to patient ${patientId}`);

  const doctorRole  = docRes.rows[0].role;
  const severity    = allergyRes.rows[0].severity;
  const requiredRole = REQUIRED_OVERRIDE_ROLE[severity];

  // ── 2. ตรวจสิทธิ์ Override ──────────────────────────────────────────────
  if (!canOverride(doctorRole, requiredRole)) {
    throw new PermissionError(
      `แพทย์ role "${doctorRole}" ไม่มีสิทธิ์ Override allergy severity "${severity}" ` +
      `(ต้องการ role "${requiredRole}" ขึ้นไป)`
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 3. บันทึก Override Log ───────────────────────────────────────────
    const overrideRes = await client.query<{ override_id: number }>(
      `INSERT INTO override_logs (patient_id, drug_id, allergy_id, overridden_by, override_reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING override_id`,
      [patientId, drugId, allergyId, doctorId, reason],
    );
    const overrideId = overrideRes.rows[0].override_id;

    // ── 4. INSERT prescription พร้อม override_id → Trigger จะข้ามการตรวจ
    const prescRes = await client.query<{ prescription_id: number }>(
      `INSERT INTO prescriptions
         (patient_id, drug_id, dosage, duration_days, prescribed_by, override_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING prescription_id`,
      [patientId, drugId, dosage, durationDays, doctorId, overrideId],
    );
    const prescriptionId = prescRes.rows[0].prescription_id;

    await client.query('COMMIT');
    return { prescriptionId, overrideId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Custom Errors ────────────────────────────────────────────────────────────

class AllergyError extends Error {
  constructor(public readonly alert: Omit<AllergyAlert, 'drugId' | 'drugName'>) {
    super(`ALLERGY_BLOCKED: severity=${alert.severity}`);
    this.name = 'AllergyError';
  }
}

class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`);
}

async function runTests(): Promise<void> {
  await setup();
  console.log('Schema + trigger + sample data ready.\n');

  // ── Test 1: สั่งยาปกติ (ไม่มีประวัติแพ้) ────────────────────────────────
  console.log('═'.repeat(62));
  console.log('Test 1: Normal prescription — no allergy (Alice → Paracetamol)');
  console.log('═'.repeat(62));
  const pid1 = await prescribeDrug(1, 5, '500mg x2/day', 5, 1);
  assert(pid1 > 0, `prescription created, id=${pid1}`);

  // ── Test 2: ตรวจพบแพ้ยาเฉพาะตัว → Block ────────────────────────────────
  console.log('\n' + '═'.repeat(62));
  console.log('Test 2: Allergy to specific drug — Alice is allergic to Amoxicillin');
  console.log('═'.repeat(62));
  await recordAllergy(1, { drugId: 1, severity: 'severe',
    reaction: 'Skin rash and swelling' }, 1);
  try {
    await prescribeDrug(1, 1, '500mg x3/day', 7, 1);
    assert(false, 'should have thrown AllergyError');
  } catch (e: any) {
    assert(e instanceof AllergyError, `AllergyError thrown — severity: ${e.alert.severity}`);
    assert(e.alert.severity === 'severe', `severity = severe → ${e.alert.severity}`);
    assert(!e.alert.isClassAllergy, `is specific drug allergy → ${!e.alert.isClassAllergy}`);
  }

  // ── Test 3: แพ้ทั้ง class → Block Ampicillin แม้ไม่ได้บันทึกเฉพาะ ──────
  console.log('\n' + '═'.repeat(62));
  console.log('Test 3: Class allergy — Bob allergic to penicillin CLASS');
  console.log('  Should block Ampicillin (also penicillin) even though only class recorded');
  console.log('═'.repeat(62));
  await recordAllergy(2, { drugClass: 'penicillin', severity: 'anaphylaxis',
    reaction: 'Anaphylactic shock' }, 2);
  try {
    await prescribeDrug(2, 2, '250mg x4/day', 7, 1); // Ampicillin = penicillin class
    assert(false, 'should have thrown AllergyError');
  } catch (e: any) {
    assert(e instanceof AllergyError, `AllergyError thrown — severity: ${e.alert.severity}`);
    assert(e.alert.isClassAllergy, `is class allergy → ${e.alert.isClassAllergy}`);
    assert(e.alert.matchedClass === 'penicillin', `matched class = penicillin`);
    assert(e.alert.requiredOverrideRole === 'head',
      `anaphylaxis requires head → ${e.alert.requiredOverrideRole}`);
  }

  // ── Test 4: checkAllergyAlerts ก่อนสั่งยา ──────────────────────────────
  console.log('\n' + '═'.repeat(62));
  console.log('Test 4: checkAllergyAlerts — pre-flight check before prescribing');
  console.log('═'.repeat(62));
  const alerts = await checkAllergyAlerts(1, 1); // Alice + Amoxicillin
  assert(alerts.length === 1, `found 1 alert → ${alerts.length}`);
  assert(alerts[0].severity === 'severe', `severity = severe`);
  console.log(`  Alert: ${alerts[0].drugName}, severity=${alerts[0].severity}, ` +
              `override needs role="${alerts[0].requiredOverrideRole}"`);

  // ── Test 5: Override โดยแพทย์ที่มีสิทธิ์ (severe → senior) ─────────────
  console.log('\n' + '═'.repeat(62));
  console.log('Test 5: Override by senior doctor — Alice severe allergy to Amoxicillin');
  console.log('  Senior doctor can override "severe", standard cannot');
  console.log('═'.repeat(62));
  const allergyId = alerts[0].allergyId;

  // Standard doctor ไม่มีสิทธิ์ Override severe
  try {
    await overrideAndPrescribe(1, 1, allergyId, '500mg x3/day', 7, 1,
      'Patient needs this drug');
    assert(false, 'standard should not override severe');
  } catch (e: any) {
    assert(e instanceof PermissionError,
      `PermissionError: standard cannot override severe → ${e.message}`);
  }

  // Senior doctor มีสิทธิ์
  const { prescriptionId, overrideId } = await overrideAndPrescribe(
    1, 1, allergyId, '500mg x3/day', 7, 2,
    'Benefits outweigh risks — patient requires Amoxicillin for resistant infection',
  );
  assert(prescriptionId > 0, `prescription created with override, id=${prescriptionId}`);
  assert(overrideId > 0, `override_log recorded, id=${overrideId}`);

  // ── Test 6: Trigger ยังคง Block แม้ไม่ผ่าน Application ─────────────────
  console.log('\n' + '═'.repeat(62));
  console.log('Test 6: Trigger blocks direct INSERT bypassing application logic');
  console.log('  (simulates another system connecting to DB directly)');
  console.log('═'.repeat(62));
  try {
    await pool.query(
      `INSERT INTO prescriptions (patient_id, drug_id, dosage, duration_days, prescribed_by)
       VALUES (2, 1, '500mg', 7, 1)` // Bob + Amoxicillin (penicillin class allergy)
    );
    assert(false, 'trigger should have blocked this INSERT');
  } catch (e: any) {
    assert(e.message.includes('ALLERGY_BLOCK'),
      `DB trigger blocked direct INSERT → "${e.message.split('|')[0]}"`);
  }

  // ── Test 7: Audit Trail — override log ──────────────────────────────────
  console.log('\n' + '═'.repeat(62));
  console.log('Test 7: Audit trail — override_logs records who/why/when');
  console.log('═'.repeat(62));
  const log = await pool.query(`
    SELECT ol.override_id, d.name AS doctor, ol.override_reason,
           p.prescription_id, pr.drug_name
    FROM override_logs ol
    JOIN doctors d       ON d.doctor_id        = ol.overridden_by
    JOIN prescriptions p ON p.override_id      = ol.override_id
    JOIN drugs pr        ON pr.drug_id         = ol.drug_id
    ORDER BY ol.override_id
  `);
  console.table(log.rows);
  assert(log.rows.length === 1, `1 override recorded → ${log.rows.length}`);
  assert(log.rows[0].doctor === 'Dr. Senior', `overridden by Dr. Senior`);

  console.log('\n=== Done ===');
  await pool.end();
}

runTests().catch(err => { console.error(err); process.exit(1); });
