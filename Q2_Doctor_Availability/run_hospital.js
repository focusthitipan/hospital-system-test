const { Client } = require('pg');

const client = new Client({
  host: '192.168.1.80',
  user: 'postgres',
  password: 'P@ssw0rd',
  database: 'postgres',
});

async function run() {
  await client.connect();

  // ─── Drop & Create ────────────────────────────────────────────────────────
  await client.query(`
    DROP TABLE IF EXISTS appointments   CASCADE;
    DROP TABLE IF EXISTS doctor_shifts  CASCADE;
    DROP TABLE IF EXISTS doctors        CASCADE;
  `);

  await client.query(`
    CREATE TABLE doctors (
      doctor_id  SERIAL       PRIMARY KEY,
      full_name  VARCHAR(100) NOT NULL,
      specialty  VARCHAR(100)
    );

    CREATE TABLE appointments (
      appointment_id SERIAL      PRIMARY KEY,
      doctor_id      INT         NOT NULL REFERENCES doctors(doctor_id),
      patient_id     INT         NOT NULL,
      start_time     TIMESTAMP   NOT NULL,
      end_time       TIMESTAMP   NOT NULL,
      status         VARCHAR(20) NOT NULL,
      CONSTRAINT chk_appt_time CHECK (end_time > start_time)
    );

    CREATE TABLE doctor_shifts (
      shift_id    SERIAL   PRIMARY KEY,
      doctor_id   INT      NOT NULL REFERENCES doctors(doctor_id),
      shift_date  DATE     NOT NULL,
      shift_start TIME     NOT NULL,
      shift_end   TIME     NOT NULL,
      is_break    BOOLEAN  NOT NULL DEFAULT FALSE,
      CONSTRAINT chk_shift_time CHECK (shift_end > shift_start)
    );

    CREATE INDEX idx_appt_doctor_time  ON appointments  (doctor_id, start_time, end_time);
    CREATE INDEX idx_appt_status       ON appointments  (status);
    CREATE INDEX idx_shift_doctor_date ON doctor_shifts (doctor_id, shift_date);
  `);
  console.log('Schema created.\n');

  // ─── Sample Data ──────────────────────────────────────────────────────────
  await client.query(`
    INSERT INTO doctors (doctor_id, full_name, specialty) VALUES
      (1, 'Dr. Somchai Rakjit',    'Internal Medicine'),
      (2, 'Dr. Malee Pongpat',     'Cardiology'),
      (3, 'Dr. Wichai Tanawut',    'Orthopedics'),
      (4, 'Dr. Sunisa Charoenwong','Pediatrics'),
      (5, 'Dr. Prayut Srisuk',     'Neurology');
  `);

  await client.query(`
    INSERT INTO doctor_shifts (doctor_id, shift_date, shift_start, shift_end, is_break) VALUES
      -- Dr.1: กะเช้า 08-14, พักกะ 10:30-11:00 (overlap กับ window!)
      (1, '2026-03-19', '08:00', '14:00', FALSE),
      (1, '2026-03-19', '10:30', '11:00', TRUE),

      -- Dr.2: กะเต็มวัน 08-16
      (2, '2026-03-19', '08:00', '16:00', FALSE),

      -- Dr.3: กะบ่าย 13-19 (ไม่ครอบคลุม window 10-11)
      (3, '2026-03-19', '13:00', '19:00', FALSE),

      -- Dr.4: กะเช้า 08-14 ไม่มีพัก
      (4, '2026-03-19', '08:00', '14:00', FALSE),

      -- Dr.5: กะเช้า 09-15, พักกะ 10:00-10:30 (overlap กับ window!)
      (5, '2026-03-19', '09:00', '15:00', FALSE),
      (5, '2026-03-19', '10:00', '10:30', TRUE);
  `);

  await client.query(`
    INSERT INTO appointments (doctor_id, patient_id, start_time, end_time, status) VALUES
      -- Dr.1: นัด confirmed เริ่ม 09:00 สิ้นสุด 10:30 → overlap (กินล้นมาถึง window)
      (1, 101, '2026-03-19 09:00:00', '2026-03-19 10:30:00', 'confirmed'),

      -- Dr.2: นัด confirmed ตรง 10:00-11:00 พอดี
      (2, 102, '2026-03-19 10:00:00', '2026-03-19 11:00:00', 'confirmed'),

      -- Dr.4: มีแต่ cancelled และ pending → ไม่นับ ยังว่างอยู่
      (4, 103, '2026-03-19 10:00:00', '2026-03-19 10:30:00', 'cancelled'),
      (4, 104, '2026-03-19 10:30:00', '2026-03-19 11:00:00', 'pending'),

      -- วันอื่น ไม่เกี่ยว
      (2, 105, '2026-03-18 10:00:00', '2026-03-18 11:00:00', 'confirmed');
  `);
  console.log('Sample data inserted.\n');

  // ─── Query 1: Main — NOT EXISTS ───────────────────────────────────────────
  console.log('═'.repeat(60));
  console.log('QUERY 1: Available Doctors (NOT EXISTS version)');
  console.log('  Window: 2026-03-19 10:00–11:00');
  console.log('═'.repeat(60));

  const q1 = await client.query(`
    SELECT d.doctor_id, d.full_name, d.specialty
    FROM doctors d

    -- แพทย์ต้องมีกะทำงานครอบคลุม window ทั้งหมด
    WHERE EXISTS (
        SELECT 1 FROM doctor_shifts ds_work
        WHERE ds_work.doctor_id  = d.doctor_id
          AND ds_work.shift_date = '2026-03-19'
          AND ds_work.is_break   = FALSE
          AND ds_work.shift_start <= '10:00:00'
          AND ds_work.shift_end   >= '11:00:00'
    )
    -- เงื่อนไข 1+3: ไม่มีนัด confirmed ที่ overlap (A_start < B_end AND A_end > B_start)
    AND NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.doctor_id  = d.doctor_id
          AND a.status     = 'confirmed'
          AND a.start_time < TIMESTAMP '2026-03-19 11:00:00'
          AND a.end_time   > TIMESTAMP '2026-03-19 10:00:00'
    )
    -- เงื่อนไข 2: ไม่อยู่ในพักกะที่ overlap กับ window
    AND NOT EXISTS (
        SELECT 1 FROM doctor_shifts ds_break
        WHERE ds_break.doctor_id  = d.doctor_id
          AND ds_break.shift_date = '2026-03-19'
          AND ds_break.is_break   = TRUE
          AND ds_break.shift_start < '11:00:00'
          AND ds_break.shift_end   > '10:00:00'
    )
    ORDER BY d.full_name;
  `);

  console.table(q1.rows);

  // ─── Query 2: CTE version ─────────────────────────────────────────────────
  console.log('═'.repeat(60));
  console.log('QUERY 2: Available Doctors (CTE version)');
  console.log('═'.repeat(60));

  const q2 = await client.query(`
    WITH
    query_window AS (
        SELECT
            DATE      '2026-03-19'          AS target_date,
            TIMESTAMP '2026-03-19 10:00:00' AS window_start,
            TIMESTAMP '2026-03-19 11:00:00' AS window_end,
            TIME      '10:00:00'            AS window_start_t,
            TIME      '11:00:00'            AS window_end_t
    ),
    doctors_on_duty AS (
        SELECT DISTINCT ds.doctor_id
        FROM   doctor_shifts ds
        CROSS JOIN query_window w
        WHERE  ds.shift_date  = w.target_date
          AND  ds.is_break    = FALSE
          AND  ds.shift_start <= w.window_start_t
          AND  ds.shift_end   >= w.window_end_t
    ),
    busy_doctors AS (
        SELECT DISTINCT a.doctor_id
        FROM   appointments a
        CROSS JOIN query_window w
        WHERE  a.status     = 'confirmed'
          AND  a.start_time < w.window_end
          AND  a.end_time   > w.window_start
    ),
    on_break_doctors AS (
        SELECT DISTINCT ds.doctor_id
        FROM   doctor_shifts ds
        CROSS JOIN query_window w
        WHERE  ds.shift_date  = w.target_date
          AND  ds.is_break    = TRUE
          AND  ds.shift_start < w.window_end_t
          AND  ds.shift_end   > w.window_start_t
    )
    SELECT d.doctor_id, d.full_name, d.specialty
    FROM   doctors d
    WHERE  d.doctor_id     IN (SELECT doctor_id FROM doctors_on_duty)
      AND  d.doctor_id NOT IN (SELECT doctor_id FROM busy_doctors)
      AND  d.doctor_id NOT IN (SELECT doctor_id FROM on_break_doctors)
    ORDER BY d.full_name;
  `);

  console.table(q2.rows);

  // ─── Query 3: Debug — สถานะทุกคน ─────────────────────────────────────────
  console.log('═'.repeat(60));
  console.log('QUERY 3: Debug — Availability status of all doctors');
  console.log('═'.repeat(60));

  const q3 = await client.query(`
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
            ) THEN 'มีนัด confirmed (overlap)'
            WHEN EXISTS (
                SELECT 1 FROM doctor_shifts ds
                WHERE ds.doctor_id  = d.doctor_id
                  AND ds.shift_date = '2026-03-19'
                  AND ds.is_break   = TRUE
                  AND ds.shift_start < '11:00:00'
                  AND ds.shift_end   > '10:00:00'
            ) THEN 'อยู่ในพักกะ (overlap)'
            ELSE 'ว่าง'
        END AS status
    FROM doctors d
    ORDER BY d.doctor_id;
  `);

  console.table(q3.rows);

  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
