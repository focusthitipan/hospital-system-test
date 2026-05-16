-- ============================================================
-- Doctor Availability Query
-- วันที่ 19 มีนาคม 2026 ช่วงเวลา 10:00–11:00 น.
-- ============================================================
-- Database: PostgreSQL (ใช้ syntax มาตรฐาน ANSI SQL เป็นหลัก)
-- ============================================================


-- ─── SCHEMA ──────────────────────────────────────────────────────────────────

CREATE TABLE doctors (
    doctor_id  SERIAL      PRIMARY KEY,
    full_name  VARCHAR(100) NOT NULL,
    specialty  VARCHAR(100)
);

-- appointments เก็บเวลาเป็น TIMESTAMP เพื่อรองรับ overlap ข้ามวัน
CREATE TABLE appointments (
    appointment_id SERIAL       PRIMARY KEY,
    doctor_id      INT          NOT NULL REFERENCES doctors(doctor_id),
    patient_id     INT          NOT NULL,
    start_time     TIMESTAMP    NOT NULL,
    end_time       TIMESTAMP    NOT NULL,
    status         VARCHAR(20)  NOT NULL,  -- 'confirmed' | 'pending' | 'cancelled'
    CONSTRAINT chk_time CHECK (end_time > start_time)
);

-- doctor_shifts เก็บกะทำงานและช่วงพักของแต่ละแพทย์
-- is_break = TRUE  → พักกะ (ไม่ให้บริการ)
-- is_break = FALSE → กะทำงานปกติ
CREATE TABLE doctor_shifts (
    shift_id    SERIAL      PRIMARY KEY,
    doctor_id   INT         NOT NULL REFERENCES doctors(doctor_id),
    shift_date  DATE        NOT NULL,
    shift_start TIME        NOT NULL,
    shift_end   TIME        NOT NULL,
    is_break    BOOLEAN     NOT NULL DEFAULT FALSE,
    CONSTRAINT chk_shift CHECK (shift_end > shift_start)
);

-- Index เพื่อเพิ่มประสิทธิภาพ Query หลัก
CREATE INDEX idx_appt_doctor_time   ON appointments  (doctor_id, start_time, end_time);
CREATE INDEX idx_appt_status        ON appointments  (status);
CREATE INDEX idx_shift_doctor_date  ON doctor_shifts (doctor_id, shift_date);


-- ─── SAMPLE DATA ──────────────────────────────────────────────────────────────

INSERT INTO doctors (doctor_id, full_name, specialty) VALUES
    (1, 'Dr. Somchai Rakjit',   'Internal Medicine'),
    (2, 'Dr. Malee Pongpat',    'Cardiology'),
    (3, 'Dr. Wichai Tanawut',   'Orthopedics'),
    (4, 'Dr. Sunisa Charoenwong','Pediatrics'),
    (5, 'Dr. Prayut Srisuk',    'Neurology');

-- กะทำงานของแพทย์ในวันที่ 19 มีนาคม 2026
-- แพทย์ 1: กะเช้า 08:00–14:00 มีพักกะ 10:30–11:00
-- แพทย์ 2: กะเช้า 08:00–16:00 ไม่มีพัก (ว่างในช่วง 10:00–11:00 ถ้าไม่มีนัด)
-- แพทย์ 3: กะบ่าย 13:00–19:00 (ยังไม่ถึงเวลา 10:00–11:00)
-- แพทย์ 4: กะเช้า 08:00–14:00 ไม่มีพัก
-- แพทย์ 5: กะเช้า 09:00–15:00 มีพักกะ 10:00–10:30

INSERT INTO doctor_shifts (doctor_id, shift_date, shift_start, shift_end, is_break) VALUES
    -- แพทย์ 1 — กะเช้า + พักกะที่ overlap กับ 10:00–11:00
    (1, '2026-03-19', '08:00', '14:00', FALSE),
    (1, '2026-03-19', '10:30', '11:00', TRUE),   -- พักกะ 10:30–11:00 (overlap!)

    -- แพทย์ 2 — กะเต็มวัน ไม่มีพัก
    (2, '2026-03-19', '08:00', '16:00', FALSE),

    -- แพทย์ 3 — กะบ่าย ไม่ครอบคลุม 10:00–11:00
    (3, '2026-03-19', '13:00', '19:00', FALSE),

    -- แพทย์ 4 — กะเช้า ไม่มีพัก
    (4, '2026-03-19', '08:00', '14:00', FALSE),

    -- แพทย์ 5 — กะเช้า + พักกะที่เริ่มตรง 10:00 พอดี (overlap!)
    (5, '2026-03-19', '09:00', '15:00', FALSE),
    (5, '2026-03-19', '10:00', '10:30', TRUE);   -- พักกะ 10:00–10:30 (overlap!)

-- นัดหมายของแพทย์ในวันที่ 19 มีนาคม 2026
INSERT INTO appointments (doctor_id, patient_id, start_time, end_time, status) VALUES
    -- แพทย์ 1: มีนัด confirmed ที่เริ่มก่อน 10:00 แต่กินเวลาล้นมาจนถึง 10:30
    --          → Overlap ตามเงื่อนไขข้อ 3 (start < 11:00 AND end > 10:00)
    (1, 101, '2026-03-19 09:00:00', '2026-03-19 10:30:00', 'confirmed'),

    -- แพทย์ 2: มีนัด confirmed ตรง 10:00–11:00 พอดี
    (2, 102, '2026-03-19 10:00:00', '2026-03-19 11:00:00', 'confirmed'),

    -- แพทย์ 4: มีนัด cancelled (ไม่นับ — status ไม่ใช่ 'confirmed')
    (4, 103, '2026-03-19 10:00:00', '2026-03-19 10:30:00', 'cancelled'),

    -- แพทย์ 4: มีนัด pending อีกอัน (ไม่นับเช่นกัน)
    (4, 104, '2026-03-19 10:30:00', '2026-03-19 11:00:00', 'pending'),

    -- นัดวันอื่นที่ไม่เกี่ยว
    (2, 105, '2026-03-18 10:00:00', '2026-03-18 11:00:00', 'confirmed');


-- ─── MAIN QUERY — Version 1: NOT EXISTS (อ่านง่าย แนะนำใช้) ─────────────────

/*
 * ตัวแปรคงที่สำหรับช่วงเวลาที่ต้องการตรวจสอบ
 *   window_start = 2026-03-19 10:00:00
 *   window_end   = 2026-03-19 11:00:00
 *   target_date  = 2026-03-19
 *
 * หลัก Interval Overlap:
 *   สองช่วงเวลา [A_start, A_end] และ [B_start, B_end] ซ้อนทับกันถ้า:
 *   A_start < B_end  AND  A_end > B_start
 *
 *   ครอบคลุมทุกกรณี:
 *   Case 1: นัดเริ่มก่อนและสิ้นสุดระหว่าง window  [09:00–10:30] overlap [10:00–11:00] ✓
 *   Case 2: นัดอยู่ภายใน window ทั้งหมด            [10:15–10:45] overlap [10:00–11:00] ✓
 *   Case 3: นัดเริ่มระหว่างและสิ้นสุดหลัง window   [10:30–12:00] overlap [10:00–11:00] ✓
 *   Case 4: นัดครอบคลุม window ทั้งหมด             [09:00–13:00] overlap [10:00–11:00] ✓
 */

SELECT
    d.doctor_id,
    d.full_name,
    d.specialty
FROM doctors d

-- (ไม่บังคับ) แพทย์ต้องมีกะทำงาน (is_break=FALSE) ครอบคลุมช่วงเวลานี้
-- ตัด: แพทย์ที่ไม่ได้ทำงานวันนี้ หรือกะไม่ครอบคลุม 10:00–11:00
WHERE EXISTS (
    SELECT 1
    FROM doctor_shifts ds_work
    WHERE ds_work.doctor_id  = d.doctor_id
      AND ds_work.shift_date = '2026-03-19'
      AND ds_work.is_break   = FALSE
      AND ds_work.shift_start <= '10:00:00'   -- กะเริ่มก่อนหรือพร้อมกับ window
      AND ds_work.shift_end   >= '11:00:00'   -- กะสิ้นสุดหลังหรือพร้อมกับ window
)

-- เงื่อนไข 1 + 3: ไม่มีนัด confirmed ที่ overlap กับ window 10:00–11:00
AND NOT EXISTS (
    SELECT 1
    FROM appointments a
    WHERE a.doctor_id  = d.doctor_id
      AND a.status     = 'confirmed'
      AND a.start_time < TIMESTAMP '2026-03-19 11:00:00'   -- นัดเริ่มก่อนสิ้นสุด window
      AND a.end_time   > TIMESTAMP '2026-03-19 10:00:00'   -- นัดสิ้นสุดหลังเริ่ม window
)

-- เงื่อนไข 2: ไม่อยู่ในพักกะที่ overlap กับ window 10:00–11:00
AND NOT EXISTS (
    SELECT 1
    FROM doctor_shifts ds_break
    WHERE ds_break.doctor_id  = d.doctor_id
      AND ds_break.shift_date = '2026-03-19'
      AND ds_break.is_break   = TRUE
      AND ds_break.shift_start < '11:00:00'   -- พักเริ่มก่อนสิ้นสุด window
      AND ds_break.shift_end   > '10:00:00'   -- พักสิ้นสุดหลังเริ่ม window
)

ORDER BY d.full_name;


-- ─── MAIN QUERY — Version 2: CTE (เหมาะกับ query ซับซ้อน / อ่าน logic แยกส่วน) ─

WITH
/*
 * ขอบเขตช่วงเวลาที่ต้องการ — กำหนดครั้งเดียว ใช้ซ้ำได้ทุก CTE
 */
query_window AS (
    SELECT
        DATE    '2026-03-19'                   AS target_date,
        TIMESTAMP '2026-03-19 10:00:00'        AS window_start,
        TIMESTAMP '2026-03-19 11:00:00'        AS window_end,
        TIME    '10:00:00'                     AS window_start_t,
        TIME    '11:00:00'                     AS window_end_t
),

/*
 * แพทย์ที่มีกะทำงาน (is_break=FALSE) ครอบคลุม window ทั้งหมด
 */
doctors_on_duty AS (
    SELECT DISTINCT ds.doctor_id
    FROM   doctor_shifts ds
    CROSS JOIN query_window w
    WHERE  ds.shift_date  = w.target_date
      AND  ds.is_break    = FALSE
      AND  ds.shift_start <= w.window_start_t
      AND  ds.shift_end   >= w.window_end_t
),

/*
 * แพทย์ที่มีนัด confirmed ที่ overlap กับ window (เงื่อนไข 1 + 3)
 *
 * Overlap condition: start_time < window_end  AND  end_time > window_start
 * ครอบคลุมกรณี "นัดก่อนหน้ากินเวลาล้นมา" ด้วยอัตโนมัติ
 * เช่น นัด 09:00–10:30 → 09:00 < 11:00 ✓ AND 10:30 > 10:00 ✓ → overlap
 */
busy_doctors AS (
    SELECT DISTINCT a.doctor_id
    FROM   appointments a
    CROSS JOIN query_window w
    WHERE  a.status     = 'confirmed'
      AND  a.start_time < w.window_end      -- เริ่มก่อน window สิ้นสุด
      AND  a.end_time   > w.window_start    -- สิ้นสุดหลัง window เริ่ม
),

/*
 * แพทย์ที่อยู่ในช่วงพักกะที่ overlap กับ window (เงื่อนไข 2)
 */
on_break_doctors AS (
    SELECT DISTINCT ds.doctor_id
    FROM   doctor_shifts ds
    CROSS JOIN query_window w
    WHERE  ds.shift_date  = w.target_date
      AND  ds.is_break    = TRUE
      AND  ds.shift_start < w.window_end_t    -- พักเริ่มก่อน window สิ้นสุด
      AND  ds.shift_end   > w.window_start_t  -- พักสิ้นสุดหลัง window เริ่ม
)

/*
 * ผลลัพธ์สุดท้าย: แพทย์ที่ว่างใน window
 *   = อยู่เวรในวันนั้น
 *   MINUS มีนัด confirmed ที่ overlap
 *   MINUS อยู่ในพักกะที่ overlap
 */
SELECT
    d.doctor_id,
    d.full_name,
    d.specialty
FROM   doctors d
WHERE  d.doctor_id     IN  (SELECT doctor_id FROM doctors_on_duty)
  AND  d.doctor_id NOT IN  (SELECT doctor_id FROM busy_doctors)
  AND  d.doctor_id NOT IN  (SELECT doctor_id FROM on_break_doctors)
ORDER BY d.full_name;


-- ─── EXPECTED RESULT ──────────────────────────────────────────────────────────
/*
 * ตรวจสอบ Sample Data ทีละคน:
 *
 * doctor_id | ว่าง? | เหตุผล
 * ----------+-------+-------------------------------------------------------
 *     1     |  NO   | มีพักกะ 10:30–11:00 → overlap กับ window
 *           |       | (และมีนัด 09:00–10:30 → overlap ด้วย)
 * ----------+-------+-------------------------------------------------------
 *     2     |  NO   | มีนัด confirmed 10:00–11:00 → overlap ตรงๆ
 * ----------+-------+-------------------------------------------------------
 *     3     |  NO   | กะเริ่ม 13:00 → ไม่ครอบคลุม window 10:00–11:00
 * ----------+-------+-------------------------------------------------------
 *     4     | YES   | มีกะ 08:00–14:00, นัดทั้งหมด cancelled/pending (ไม่นับ)
 * ----------+-------+-------------------------------------------------------
 *     5     |  NO   | มีพักกะ 10:00–10:30 → overlap กับ window
 *
 * ผลลัพธ์ที่คาดหวัง:
 *   doctor_id | full_name              | specialty
 *   ----------+------------------------+----------
 *           4 | Dr. Sunisa Charoenwong | Pediatrics
 */


-- ─── BONUS: Query ตรวจสอบ Overlap ของทุกคนพร้อมเหตุผล (Debug View) ──────────

SELECT
    d.doctor_id,
    d.full_name,
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM doctor_shifts ds
            WHERE ds.doctor_id  = d.doctor_id
              AND ds.shift_date = '2026-03-19'
              AND ds.is_break   = FALSE
              AND ds.shift_start <= '10:00:00'
              AND ds.shift_end   >= '11:00:00'
        ) THEN 'ไม่มีกะครอบคลุมช่วงเวลานี้'
        WHEN EXISTS (
            SELECT 1 FROM appointments a
            WHERE a.doctor_id  = d.doctor_id
              AND a.status     = 'confirmed'
              AND a.start_time < TIMESTAMP '2026-03-19 11:00:00'
              AND a.end_time   > TIMESTAMP '2026-03-19 10:00:00'
        ) THEN 'มีนัด confirmed ในช่วงเวลานี้'
        WHEN EXISTS (
            SELECT 1 FROM doctor_shifts ds
            WHERE ds.doctor_id  = d.doctor_id
              AND ds.shift_date = '2026-03-19'
              AND ds.is_break   = TRUE
              AND ds.shift_start < '11:00:00'
              AND ds.shift_end   > '10:00:00'
        ) THEN 'อยู่ในพักกะ'
        ELSE 'ว่าง'
    END AS availability_status
FROM doctors d
ORDER BY d.doctor_id;
