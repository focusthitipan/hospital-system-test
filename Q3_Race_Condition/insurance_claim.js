"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
// ============================================================
// ข้อ 3: Code Review — The Race Condition
// ============================================================
// ─── ORIGINAL BUGGY CODE (อย่านำไปใช้) ──────────────────────────────────────
//
// async function claimInsurance(patientId, treatmentCost) {
//     const p = await db.query(
//         `SELECT limit FROM patients WHERE id = ${patientId}`)   ← BUG 1
//     if (p.limit >= treatmentCost) {
//         const newLimit = p.limit - treatmentCost;
//         await db.query(
//             `UPDATE patients SET limit = ${newLimit} WHERE id = ${patientId}`) ← BUG 2
//         return true;
//     }
//     return false;
// }
//
// BUG 1 — SQL Injection
//   patientId ถูกแทรกตรงๆ ใน query string
//   ผู้โจมตีส่ง patientId = "0 OR 1=1" → query กลายเป็น
//   SELECT limit FROM patients WHERE id = 0 OR 1=1
//   → ดึงข้อมูลทุก row ออกมา หรือส่ง payload ลบตาราง DROP TABLE ได้
//
// BUG 2 — Race Condition (Read-Check-Write is NOT atomic)
//   เมื่อสองคำขอมาพร้อมกัน:
//
//   เวลา  │ คำขอ A (cost=600)         │ คำขอ B (cost=600)
//   ──────┼───────────────────────────┼──────────────────────────
//   t=1   │ READ  limit = 1000        │
//   t=2   │                           │ READ  limit = 1000
//   t=3   │ CHECK 1000 >= 600 ✓       │
//   t=4   │                           │ CHECK 1000 >= 600 ✓ ← อ่านค่าเก่า!
//   t=5   │ WRITE limit = 400         │
//   t=6   │                           │ WRITE limit = 400
//   t=7   │ return true               │ return true
//
//   ผล: อนุมัติสองครั้ง (1,200 บาท) บนวงเงิน 1,000 บาท
//   DB เก็บ 400 แทนที่จะเป็น -200 → หนังสือบัญชีผิด แต่ไม่มี error!
// ─── SCHEMA ──────────────────────────────────────────────────────────────────
const pool = new pg_1.Pool({
    host: '192.168.1.80',
    user: 'postgres',
    password: 'P@ssw0rd',
    database: 'postgres',
    max: 10, // connection pool สูงสุด 10 เส้นพร้อมกัน
});
async function setup() {
    await pool.query(`
    DROP TABLE IF EXISTS patients;
    CREATE TABLE patients (
      id               SERIAL        PRIMARY KEY,
      name             VARCHAR(100)  NOT NULL,
      insurance_limit  NUMERIC(10,2) NOT NULL CHECK (insurance_limit >= 0)
    );
    INSERT INTO patients (id, name, insurance_limit) VALUES
      (1, 'Alice', 1000.00),
      (2, 'Bob',    500.00);
  `);
}
// ─── FIXED: claimInsurance ────────────────────────────────────────────────────
async function claimInsurance(patientId, treatmentCost) {
    // ใช้ client แยกต่างหาก (ไม่ใช้ pool.query) เพื่อ BEGIN/COMMIT ได้ใน connection เดียว
    const client = await pool.connect();
    try {
        // ── 1. เริ่ม Transaction ─────────────────────────────────────────────────
        await client.query('BEGIN');
        // ── 2. SELECT FOR UPDATE — ล็อก row นี้ระดับ row-level ──────────────────
        //
        //   - $1 คือ parameterized query → SQL Injection ไม่สามารถทำงานได้
        //     เพราะ patientId ถูกส่งแยกจาก query string
        //     PostgreSQL จะ parse query ก่อน แล้วค่อยแทน parameter ทีหลัง
        //
        //   - FOR UPDATE คือ Row-level Lock
        //     Transaction อื่นที่ SELECT FOR UPDATE row เดียวกันจะถูกบังคับให้รอ
        //     จนกว่า transaction นี้จะ COMMIT หรือ ROLLBACK
        //
        const result = await client.query('SELECT insurance_limit FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return false; // ไม่พบผู้ป่วย
        }
        const current = Number(result.rows[0].insurance_limit);
        // ── 3. ตรวจสอบวงเงิน ────────────────────────────────────────────────────
        if (current < treatmentCost) {
            await client.query('ROLLBACK');
            return false; // วงเงินไม่พอ
        }
        // ── 4. ตัดวงเงิน ────────────────────────────────────────────────────────
        //   ใช้ insurance_limit - $1 แทนการส่งค่าที่คำนวณล่วงหน้า
        //   เพื่อให้ DB ทำการลบบน lock value ที่แน่นอน
        await client.query('UPDATE patients SET insurance_limit = insurance_limit - $1 WHERE id = $2', [treatmentCost, patientId]);
        // ── 5. COMMIT — ปลด lock และยืนยันการเปลี่ยนแปลง ──────────────────────
        await client.query('COMMIT');
        return true;
    }
    catch (err) {
        // ถ้า error ใดๆ เกิดขึ้น → ROLLBACK ทั้งหมด ไม่มีข้อมูลเปลี่ยน
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        // คืน connection กลับ pool เสมอ ไม่ว่าจะ success หรือ error
        client.release();
    }
}
// ─── TESTS ────────────────────────────────────────────────────────────────────
async function getLimit(patientId) {
    const r = await pool.query('SELECT insurance_limit FROM patients WHERE id = $1', [patientId]);
    return Number(r.rows[0].insurance_limit);
}
function assert(condition, message) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'} — ${message}`);
}
async function runTests() {
    await setup();
    console.log('Schema + sample data ready.\n');
    // ── Test 1: นัดหมายปกติ ───────────────────────────────────────────────────
    console.log('═'.repeat(62));
    console.log('Test 1: Normal claim  (Alice limit=1000, cost=300)');
    console.log('═'.repeat(62));
    const t1 = await claimInsurance(1, 300);
    const l1 = await getLimit(1);
    assert(t1 === true, `claim returned true → ${t1}`);
    assert(l1 === 700, `limit reduced to 700 → ${l1}`);
    // ── Test 2: วงเงินไม่พอ ───────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(62));
    console.log('Test 2: Insufficient limit  (limit=700, cost=800)');
    console.log('═'.repeat(62));
    const t2 = await claimInsurance(1, 800);
    const l2 = await getLimit(1);
    assert(t2 === false, `claim returned false → ${t2}`);
    assert(l2 === 700, `limit unchanged at 700 → ${l2}`);
    // ── Test 3: ผู้ป่วยไม่มีในระบบ ───────────────────────────────────────────
    console.log('\n' + '═'.repeat(62));
    console.log('Test 3: Patient not found  (id=999)');
    console.log('═'.repeat(62));
    const t3 = await claimInsurance(999, 100);
    assert(t3 === false, `claim returned false for unknown patient → ${t3}`);
    // ── Test 4: Race Condition ─────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(62));
    console.log('Test 4: Race Condition — 2 concurrent claims of 600 on limit=1000');
    console.log('  Without lock: both read 1000, both pass check → both approved (1200 on 1000!)');
    console.log('  With FOR UPDATE: 2nd waits, reads 400 < 600 → rejected');
    console.log('═'.repeat(62));
    // Reset Alice's limit to 1000
    await pool.query('UPDATE patients SET insurance_limit = 1000 WHERE id = 1');
    // ยิงสองคำขอพร้อมกันจริงๆ
    const [r1, r2] = await Promise.all([
        claimInsurance(1, 600),
        claimInsurance(1, 600),
    ]);
    const l4 = await getLimit(1);
    const approved = [r1, r2].filter(Boolean).length;
    console.log(`  Claim A result: ${r1}`);
    console.log(`  Claim B result: ${r2}`);
    console.log(`  Final limit   : ${l4}`);
    assert(approved === 1, `exactly 1 claim approved (not 2) → ${approved} approved`);
    assert(l4 === 400, `limit correctly at 400, not negative → ${l4}`);
    // ── Test 5: SQL Injection ─────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(62));
    console.log('Test 5: SQL Injection  patientId = "1 OR 1=1"');
    console.log('  With $1 parameterized: treated as literal string, not executed as SQL');
    console.log('═'.repeat(62));
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t5 = await claimInsurance('1 OR 1=1', 100);
        assert(t5 === false, `injection returned false (no row matched) → ${t5}`);
    }
    catch (e) {
        // PostgreSQL ส่ง "invalid input syntax for type integer" → injection ถูกปฏิเสธโดย type system
        const isSafe = e.message.includes('invalid input syntax');
        assert(isSafe, `injection rejected by type check: "${e.message.split('\n')[0]}"`);
    }
    console.log('\n=== Done ===');
    await pool.end();
}
runTests().catch(err => { console.error(err); process.exit(1); });
