"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const crypto_1 = require("crypto");
// ============================================================
// ข้อ 5: System Scalability — Lab Results (X-Ray Image)
// ============================================================
//
//  Architecture Overview
//  ┌─────────────────────────────────────────────────────────┐
//  │  Mobile / Tablet                                        │
//  │     ↓  HTTPS only                                      │
//  │  ┌─────────────────────────────────────────────────┐   │
//  │  │  API Server  (RBAC + Signed URL Generator)      │   │
//  │  └────────────────────┬────────────────────────────┘   │
//  │                       │ cache-hit → serve compressed   │
//  │  ┌────────────────────▼────────────────────────────┐   │
//  │  │  Internal CDN / Nginx (ward-level cache)        │   │
//  │  │  Short TTL: 5 min  |  No-Store for original     │   │
//  │  └────────────────────┬────────────────────────────┘   │
//  │                       │ cache-miss                     │
//  │  ┌────────────────────▼────────────────────────────┐   │
//  │  │  Object Storage (MinIO / S3-compatible)         │   │
//  │  │  AES-256 at-rest encryption                     │   │
//  │  │  Variants: thumbnail | mobile | tablet | orig   │   │
//  │  └─────────────────────────────────────────────────┘   │
//  └─────────────────────────────────────────────────────────┘
const pool = new pg_1.Pool({
    host: '192.168.1.80', user: 'postgres',
    password: 'P@ssw0rd', database: 'postgres', max: 10,
});
// HMAC secret — ในระบบจริงอ่านจาก environment variable / secrets manager
const HMAC_SECRET = process.env.HMAC_SECRET ?? 'medcare_secret_2026_change_in_prod';
const TOKEN_TTL_MINUTES = 15; // mobile token อายุ 15 นาที (PDPA: ลดเวลาเปิดรับข้อมูล)
// ─── Storage Strategy: Image Variant Config ───────────────────────────────────
//
//  thumbnail  → แสดงในรายการผล lab (list view)      — cache ได้นาน
//  mobile     → ดูบน mobile ทั่วโรงพยาบาล          — cache สั้น (sensitive)
//  tablet     → ดูบน tablet ของแพทย์               — no-cache (sensitive)
//  original   → radiologist workstation / archive  — no-store (ห้าม cache เลย)
const RESOLUTION_SPECS = {
    thumbnail: { width: 200, height: 200, jpegQuality: 60, estimatedKb: 8,
        cacheMaxAgeSec: 3600, cacheDirective: 'private, max-age=3600' },
    mobile: { width: 1024, height: 768, jpegQuality: 75, estimatedKb: 120,
        cacheMaxAgeSec: 300, cacheDirective: 'private, max-age=300, no-transform' },
    tablet: { width: 2048, height: 1536, jpegQuality: 85, estimatedKb: 600,
        cacheMaxAgeSec: 0, cacheDirective: 'private, no-cache' },
    original: { width: 4096, height: 4096, jpegQuality: 100, estimatedKb: 12000,
        cacheMaxAgeSec: 0, cacheDirective: 'no-store' },
};
// เลือก resolution ที่เหมาะสมตาม device — ลด bandwidth + ป้องกัน original หลุด
function selectResolution(deviceType) {
    if (deviceType === 'workstation')
        return 'original';
    if (deviceType === 'tablet')
        return 'tablet';
    return 'mobile';
}
// ─── Schema ───────────────────────────────────────────────────────────────────
async function setup() {
    await pool.query(`
    DROP TABLE IF EXISTS image_access_logs   CASCADE;
    DROP TABLE IF EXISTS image_access_tokens CASCADE;
    DROP TABLE IF EXISTS lab_images          CASCADE;
    DROP TABLE IF EXISTS lab_results         CASCADE;
    DROP TABLE IF EXISTS doctors             CASCADE;
    DROP TABLE IF EXISTS patients            CASCADE;
  `);
    await pool.query(`
    CREATE TABLE patients (
      patient_id  SERIAL  PRIMARY KEY,
      name        VARCHAR(100) NOT NULL
    );

    CREATE TABLE doctors (
      doctor_id  SERIAL       PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      role       VARCHAR(20)  NOT NULL
        CONSTRAINT chk_role CHECK (role IN ('doctor','radiologist','admin'))
    );

    -- ผล Lab / คำสั่ง Lab
    CREATE TABLE lab_results (
      lab_result_id  SERIAL      PRIMARY KEY,
      patient_id     INT         NOT NULL REFERENCES patients(patient_id),
      ordered_by     INT         NOT NULL REFERENCES doctors(doctor_id),
      lab_type       VARCHAR(50) NOT NULL,     -- 'xray', 'ct', 'mri', 'blood'
      performed_at   TIMESTAMP   NOT NULL DEFAULT NOW(),
      report_text    TEXT,
      is_sensitive   BOOLEAN     NOT NULL DEFAULT FALSE  -- ถ้า TRUE → เพิ่ม audit level
    );

    -- ไฟล์ภาพแต่ละ variant พร้อม metadata ของที่เก็บ
    -- storage_path: path ใน Object Storage (MinIO/S3) → ไม่เปิดเผยต่อ client ตรงๆ
    -- sha256_checksum: ตรวจความถูกต้องของไฟล์ (integrity)
    -- is_encrypted: ยืนยันว่า AES-256 encryption at-rest ทำแล้ว
    CREATE TABLE lab_images (
      image_id        SERIAL        PRIMARY KEY,
      lab_result_id   INT           NOT NULL REFERENCES lab_results(lab_result_id),
      resolution      VARCHAR(20)   NOT NULL
        CONSTRAINT chk_resolution CHECK (resolution IN ('thumbnail','mobile','tablet','original')),
      width_px        INT           NOT NULL,
      height_px       INT           NOT NULL,
      file_size_kb    INT           NOT NULL,
      jpeg_quality    INT           NOT NULL,
      storage_path    VARCHAR(500)  NOT NULL,   -- internal path เท่านั้น
      sha256_checksum VARCHAR(64)   NOT NULL,   -- integrity check
      is_encrypted    BOOLEAN       NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMP     NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_image_resolution UNIQUE (lab_result_id, resolution)
    );

    -- Signed URL tokens (time-limited access)
    -- ผูกกับ doctor, image, device_ip เพื่อป้องกัน token theft
    CREATE TABLE image_access_tokens (
      token_id      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      image_id      INT           NOT NULL REFERENCES lab_images(image_id),
      doctor_id     INT           NOT NULL REFERENCES doctors(doctor_id),
      resolution    VARCHAR(20)   NOT NULL,
      device_ip     INET          NOT NULL,    -- ผูก token กับ IP ที่ขอ
      hmac_sig      VARCHAR(128)  NOT NULL,    -- HMAC-SHA256 signature
      issued_at     TIMESTAMP     NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ   NOT NULL,
      is_used       BOOLEAN       NOT NULL DEFAULT FALSE  -- single-use สำหรับ original
    );

    -- PDPA Audit Log — บันทึกทุก access ไม่ว่าจะสำเร็จหรือไม่
    -- ห้าม DELETE ห้าม UPDATE → append-only (enforce ด้วย trigger)
    -- เก็บไว้ 3 ปีตาม PDPA
    CREATE TABLE image_access_logs (
      log_id        BIGSERIAL     PRIMARY KEY,
      image_id      INT           NOT NULL REFERENCES lab_images(image_id),
      doctor_id     INT,                       -- NULL ถ้า anonymous attempt
      resolution    VARCHAR(20),
      access_type   VARCHAR(20)   NOT NULL,    -- 'view' | 'download'
      result        VARCHAR(40)   NOT NULL,    -- 'granted' | 'denied_...'
      device_ip     INET,
      user_agent    TEXT,
      accessed_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
      token_id      UUID,                      -- ถ้าใช้ signed URL
      deny_reason   TEXT                       -- รายละเอียดถ้า denied
    );

    -- Trigger: ป้องกันการลบหรือแก้ไข access log (PDPA: immutable audit trail)
    CREATE OR REPLACE FUNCTION fn_protect_audit_log()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE: image_access_logs ห้าม UPDATE หรือ DELETE';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_protect_audit_log
    BEFORE UPDATE OR DELETE ON image_access_logs
    FOR EACH ROW EXECUTE FUNCTION fn_protect_audit_log();

    -- Indexes เพื่อ query audit logs ได้รวดเร็ว (PDPA compliance officer)
    CREATE INDEX idx_access_log_image   ON image_access_logs (image_id, accessed_at);
    CREATE INDEX idx_access_log_doctor  ON image_access_logs (doctor_id, accessed_at);
    CREATE INDEX idx_token_expires      ON image_access_tokens (expires_at, is_used);
  `);
    // Sample data
    await pool.query(`
    INSERT INTO patients  VALUES (1,'Alice'),(2,'Bob');
    INSERT INTO doctors   VALUES
      (1,'Dr. Smith',    'doctor'),
      (2,'Dr. Jones',    'radiologist'),
      (3,'Dr. Other',    'doctor');   -- ไม่มีผู้ป่วยในความดูแล

    INSERT INTO lab_results (lab_result_id, patient_id, ordered_by, lab_type, is_sensitive)
    VALUES (1, 1, 1, 'xray', FALSE);

    -- ลงทะเบียน 4 variants ของภาพ X-Ray เดียวกัน
    INSERT INTO lab_images
      (image_id, lab_result_id, resolution, width_px, height_px, file_size_kb,
       jpeg_quality, storage_path, sha256_checksum, is_encrypted)
    VALUES
      (1, 1,'thumbnail', 200,  200,      8, 60, 'xray/2026/03/xr001_thumb.jpg',    'abc001', TRUE),
      (2, 1,'mobile',   1024,  768,    120, 75, 'xray/2026/03/xr001_mobile.jpg',   'abc002', TRUE),
      (3, 1,'tablet',   2048, 1536,    600, 85, 'xray/2026/03/xr001_tablet.jpg',   'abc003', TRUE),
      (4, 1,'original', 4096, 4096, 12000,100, 'xray/2026/03/xr001_original.tiff','abc004', TRUE);
  `);
}
// ─── RBAC: ตรวจสิทธิ์ก่อนออก Signed URL ─────────────────────────────────────
async function checkDoctorAccess(doctorId, labResultId) {
    const r = await pool.query(`
    SELECT 1 FROM lab_results lr
    JOIN doctors d ON d.doctor_id = $1
    WHERE lr.lab_result_id = $2
      AND (
        lr.ordered_by = $1            -- แพทย์ที่สั่ง Lab
        OR d.role = 'radiologist'     -- radiologist เห็นได้ทุก Lab
      )
    LIMIT 1
  `, [doctorId, labResultId]);
    return r.rows.length > 0;
}
// ─── Signed URL Generator ─────────────────────────────────────────────────────
//
//  Signed URL = /api/images/{token_id}
//  token_id   = UUID สุ่ม (ไม่มีข้อมูลผู้ป่วยใน URL)
//  HMAC-SHA256 ผูก: tokenId | imageId | doctorId | deviceIp | expiresAt
//  → ถ้าแก้ค่าใดก็ตาม signature จะไม่ผ่าน
function signToken(tokenId, imageId, doctorId, deviceIp, expiresAt) {
    const payload = `${tokenId}|${imageId}|${doctorId}|${deviceIp}|${expiresAt}`;
    return (0, crypto_1.createHmac)('sha256', HMAC_SECRET).update(payload).digest('hex');
}
async function requestSignedUrl(params) {
    const { labResultId, imageId, doctorId, deviceIp, accessType } = params;
    // 1. ตรวจ RBAC
    const hasAccess = await checkDoctorAccess(doctorId, labResultId);
    if (!hasAccess) {
        await logAccess({ imageId, doctorId, resolution: null, accessType,
            result: 'denied_no_permission', deviceIp, denyReason: 'RBAC check failed' });
        return null;
    }
    // 2. ดึง resolution ที่เหมาะสมกับ image นั้น
    const imgRes = await pool.query('SELECT resolution FROM lab_images WHERE image_id = $1', [imageId]);
    if (imgRes.rows.length === 0)
        return null;
    const resolution = imgRes.rows[0].resolution;
    // 3. สร้าง Token
    const tokenId = (0, crypto_1.randomBytes)(16).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60000);
    const hmacSig = signToken(tokenId, imageId, doctorId, deviceIp, expiresAt.toISOString());
    await pool.query(`
    INSERT INTO image_access_tokens
      (token_id, image_id, doctor_id, resolution, device_ip, hmac_sig, expires_at)
    VALUES ($1, $2, $3, $4, $5::INET, $6, $7)
  `, [tokenId, imageId, doctorId, resolution, deviceIp, hmacSig, expiresAt]);
    await logAccess({ imageId, doctorId, resolution, accessType,
        result: 'granted', deviceIp, tokenId });
    return {
        tokenId,
        url: `/api/images/${tokenId}`, // URL ไม่มีข้อมูลผู้ป่วยเลย (PDPA)
        expiresAt,
        cacheDirective: RESOLUTION_SPECS[resolution].cacheDirective,
    };
}
// ─── Token Validation (ฝั่ง CDN / API Gateway) ───────────────────────────────
async function validateToken(tokenId, requestingIp) {
    const r = await pool.query(`
    SELECT t.image_id, t.doctor_id, t.resolution, host(t.device_ip) AS device_ip,
           t.hmac_sig, t.expires_at, t.is_used, i.storage_path
    FROM image_access_tokens t
    JOIN lab_images i ON i.image_id = t.image_id
    WHERE t.token_id = $1
  `, [tokenId]);
    if (r.rows.length === 0)
        return { result: 'denied_invalid_signature' };
    const t = r.rows[0];
    // 1. ตรวจ HMAC signature
    const expiresStr = t.expires_at instanceof Date
        ? t.expires_at.toISOString()
        : new Date(t.expires_at).toISOString();
    const expected = signToken(tokenId, t.image_id, t.doctor_id, t.device_ip, expiresStr);
    if (expected !== t.hmac_sig)
        return { result: 'denied_invalid_signature' };
    // 2. ตรวจหมดอายุ
    if (new Date() > t.expires_at)
        return { result: 'denied_expired' };
    // 3. ตรวจ IP binding (ป้องกัน token theft)
    if (requestingIp !== t.device_ip)
        return { result: 'denied_ip_mismatch' };
    // 4. original = single-use token
    if (t.resolution === 'original') {
        if (t.is_used)
            return { result: 'denied_expired' };
        await pool.query('UPDATE image_access_tokens SET is_used = TRUE WHERE token_id = $1', [tokenId]);
    }
    return {
        result: 'granted',
        storagePath: t.storage_path,
        cacheDirective: RESOLUTION_SPECS[t.resolution].cacheDirective,
    };
}
// ─── PDPA Audit Log ───────────────────────────────────────────────────────────
async function logAccess(entry) {
    await pool.query(`
    INSERT INTO image_access_logs
      (image_id, doctor_id, resolution, access_type, result, device_ip, token_id, deny_reason)
    VALUES ($1, $2, $3, $4, $5, $6::INET, $7, $8)
  `, [entry.imageId, entry.doctorId, entry.resolution, entry.accessType,
        entry.result, entry.deviceIp, entry.tokenId ?? null, entry.denyReason ?? null]);
}
// PDPA Compliance: query audit logs (compliance officer / DPO)
async function getAuditReport(imageId) {
    const r = await pool.query(`
    SELECT
      l.log_id,
      d.name       AS doctor,
      l.resolution,
      l.access_type,
      l.result,
      host(l.device_ip) AS device_ip,
      TO_CHAR(l.accessed_at, 'YYYY-MM-DD HH24:MI:SS') AS accessed_at,
      l.deny_reason
    FROM image_access_logs l
    LEFT JOIN doctors d ON d.doctor_id = l.doctor_id
    WHERE l.image_id = $1
    ORDER BY l.accessed_at
  `, [imageId]);
    console.table(r.rows);
}
// ─── Tests ────────────────────────────────────────────────────────────────────
function assert(cond, msg) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`);
}
async function runTests() {
    await setup();
    console.log('Schema + trigger + sample data ready.\n');
    // ── Test 1: Resolution selector ───────────────────────────────────────────
    console.log('═'.repeat(64));
    console.log('Test 1: Resolution selection per device type');
    console.log('═'.repeat(64));
    const specs = {
        mobile: RESOLUTION_SPECS[selectResolution('mobile')],
        tablet: RESOLUTION_SPECS[selectResolution('tablet')],
        workstation: RESOLUTION_SPECS[selectResolution('workstation')],
    };
    console.log(`  Mobile      → ${selectResolution('mobile')}` +
        ` (${specs.mobile.estimatedKb}KB, quality ${specs.mobile.jpegQuality}%,` +
        ` cache: "${specs.mobile.cacheDirective}")`);
    console.log(`  Tablet      → ${selectResolution('tablet')}` +
        ` (${specs.tablet.estimatedKb}KB, quality ${specs.tablet.jpegQuality}%,` +
        ` cache: "${specs.tablet.cacheDirective}")`);
    console.log(`  Workstation → ${selectResolution('workstation')}` +
        ` (${specs.workstation.estimatedKb}KB, quality ${specs.workstation.jpegQuality}%,` +
        ` cache: "${specs.workstation.cacheDirective}")`);
    assert(selectResolution('mobile') === 'mobile', 'mobile gets compressed variant');
    assert(selectResolution('workstation') === 'original', 'workstation gets original');
    assert(specs.workstation.cacheDirective === 'no-store', 'original: no-store (PDPA)');
    // ── Test 2: Dr. Smith (ordered lab) requests mobile image ─────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 2: Authorized doctor requests signed URL');
    console.log('═'.repeat(64));
    const token2 = await requestSignedUrl({
        labResultId: 1, imageId: 2, doctorId: 1,
        deviceIp: '192.168.10.5', accessType: 'view',
    });
    assert(token2 !== null, `signed URL issued: /api/images/${token2?.tokenId.slice(0, 8)}...`);
    assert(token2.url.startsWith('/api/images/'), 'URL contains no patient data');
    assert(!token2.url.includes('alice') && !token2.url.includes('patient'), 'URL leaks no patient identity');
    console.log(`  URL: ${token2.url}`);
    console.log(`  Expires: ${token2.expiresAt.toLocaleTimeString()}`);
    console.log(`  Cache: "${token2.cacheDirective}"`);
    // ── Test 3: Dr. Other (unrelated doctor) ถูก deny ─────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 3: Unauthorized doctor denied (RBAC)');
    console.log('═'.repeat(64));
    const token3 = await requestSignedUrl({
        labResultId: 1, imageId: 2, doctorId: 3,
        deviceIp: '192.168.10.9', accessType: 'view',
    });
    assert(token3 === null, 'unauthorized doctor gets null (no token issued)');
    // ── Test 4: Validate token — correct IP ───────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 4: Token validation — correct IP → granted');
    console.log('═'.repeat(64));
    const v4 = await validateToken(token2.tokenId, '192.168.10.5');
    assert(v4.result === 'granted', `validation result: ${v4.result}`);
    assert(!!v4.storagePath, `storage path returned (internal only): ${v4.storagePath}`);
    assert(v4.storagePath.startsWith('xray/'), 'path is internal, not public URL');
    // ── Test 5: Token ถูก replay จาก IP อื่น ─────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 5: Token replay from different IP → denied (PDPA: IP binding)');
    console.log('═'.repeat(64));
    const v5 = await validateToken(token2.tokenId, '192.168.99.99');
    assert(v5.result === 'denied_ip_mismatch', `result: ${v5.result}`);
    // ── Test 6: Expired token ─────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 6: Expired token → denied');
    console.log('═'.repeat(64));
    // สร้าง token ที่หมดอายุแล้ว (expires_at ในอดีต)
    const expiredTokenId = (0, crypto_1.randomBytes)(16).toString('hex');
    const pastTime = new Date(Date.now() - 60000); // 1 นาทีที่แล้ว
    const expiredSig = signToken(expiredTokenId, 2, 1, '192.168.10.5', pastTime.toISOString());
    await pool.query(`
    INSERT INTO image_access_tokens
      (token_id, image_id, doctor_id, resolution, device_ip, hmac_sig, expires_at)
    VALUES ($1, 2, 1, 'mobile', '192.168.10.5'::INET, $2, $3)
  `, [expiredTokenId, expiredSig, pastTime]);
    const v6 = await validateToken(expiredTokenId, '192.168.10.5');
    assert(v6.result === 'denied_expired', `result: ${v6.result}`);
    // ── Test 7: original = single-use token ──────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 7: Original image — single-use token (cannot replay)');
    console.log('═'.repeat(64));
    const token7 = await requestSignedUrl({
        labResultId: 1, imageId: 4, doctorId: 2, // radiologist
        deviceIp: '10.0.1.20', accessType: 'view',
    });
    const v7a = await validateToken(token7.tokenId, '10.0.1.20');
    const v7b = await validateToken(token7.tokenId, '10.0.1.20'); // replay
    assert(v7a.result === 'granted', `first access: ${v7a.result}`);
    assert(v7b.result === 'denied_expired', `replay blocked: ${v7b.result}`);
    // ── Test 8: PDPA Audit Log — immutable ───────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 8: Audit log is immutable (PDPA requirement)');
    console.log('═'.repeat(64));
    try {
        await pool.query(`UPDATE image_access_logs SET result = 'granted' WHERE log_id = 1`);
        assert(false, 'should have thrown');
    }
    catch (e) {
        assert(e.message.includes('AUDIT_LOG_IMMUTABLE'), `trigger blocks UPDATE: "${e.message}"`);
    }
    // ── Test 9: PDPA Audit Report ─────────────────────────────────────────────
    console.log('\n' + '═'.repeat(64));
    console.log('Test 9: PDPA Audit Report — image_id = 2 (all access attempts)');
    console.log('═'.repeat(64));
    await getAuditReport(2);
    console.log('\n=== Done ===');
    await pool.end();
}
runTests().catch(err => { console.error(err); process.exit(1); });
