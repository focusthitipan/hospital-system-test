# Hospital System — Technical Assessment

ชุดโจทย์ด้าน Software Engineering สำหรับระบบโรงพยาบาล ครอบคลุมการออกแบบ Algorithm, Database Query, Security, Scalability และ AI Integration

---

## โจทย์ทั้งหมด

| # | หัวข้อ | เทคโนโลยี |
|---|--------|-----------|
| Q1 | Priority Queue สำหรับคิวผู้ป่วย | TypeScript |
| Q2 | ค้นหาแพทย์ที่ว่างในช่วงเวลาที่กำหนด | PostgreSQL |
| Q3 | Code Review — Race Condition & SQL Injection | TypeScript, PostgreSQL |
| Q4 | ระบบตรวจสอบการแพ้ยา | TypeScript, PostgreSQL |
| Q5 | Scalability สำหรับการโหลดภาพผลแล็บ (X-Ray) | TypeScript, MinIO/S3, CDN |
| Q6 | AI Symptom Parser จากการสนทนา | TypeScript, OpenAI API |
| Q7 | Smart Drug Interaction Checker | TypeScript, PostgreSQL, OpenAI API |

---

## Q1 — Hospital Intelligent Priority Queue

**ไฟล์:** `Q1_Priority_Queue/hospital_queue.ts`

ระบบคิวผู้ป่วยอัจฉริยะที่จัดลำดับความเร่งด่วนตามกฎดังนี้:

1. **Emergency (E)** มาก่อน **Normal (N)** เสมอ
2. ภายในกลุ่มเดียวกัน → Severity สูงกว่าชนะ
3. Normal ที่รอเกิน 60 นาที → ยก priority เป็น Emergency ชั่วคราว (Wait-Time Elevation)

**สิ่งที่ Implement:**
- `getUrgentPatient()` — Linear Scan O(n) สำหรับ one-shot query
- `HospitalPriorityQueue` — Max-Heap พร้อม dynamic elevation support
- Test Suite ครอบคลุม 7 test cases รวม performance test (10,000 patients)

**Time Complexity:**

| Operation | Complexity |
|-----------|-----------|
| `getUrgentPatient` | O(n) |
| `enqueue` | O(log n) |
| `dequeueUrgent` | O(n) — เพราะ dynamic elevation |
| `advanceTime` | O(n) — rebuild heap |

---

## Q2 — Doctor Availability Query

**ไฟล์:** `Q2_Doctor_Availability/doctor_availability.sql`

SQL Query หาแพทย์ที่ **ว่าง** ในวันที่ 19 มีนาคม 2026 ช่วง 10:00–11:00 น.

**เงื่อนไขความว่าง:**
1. มีกะทำงาน (`is_break = FALSE`) ครอบคลุมช่วงเวลาทั้งหมด
2. ไม่มีนัด `confirmed` ที่ overlap กับช่วงเวลา
3. ไม่อยู่ในพักกะที่ overlap กับช่วงเวลา

**หลัก Interval Overlap:** สองช่วง `[A_start, A_end]` และ `[B_start, B_end]` ซ้อนทับกันเมื่อ:
```
A_start < B_end  AND  A_end > B_start
```

มี 2 เวอร์ชัน: `NOT EXISTS` (อ่านง่าย) และ `CTE` (แยก logic ชัดเจน)

**ผลลัพธ์ที่คาดหวัง:** `Dr. Sunisa Charoenwong` (Pediatrics)

---

## Q3 — Code Review: Race Condition & SQL Injection

**ไฟล์:** `Q3_Race_Condition/insurance_claim.ts`

วิเคราะห์ bug ใน code เดิม และแก้ไขให้ถูกต้อง

**Bug ที่พบ:**

**Bug 1 — SQL Injection**
```sql
-- โค้ดเดิม (อันตราย)
SELECT limit FROM patients WHERE id = ${patientId}
```
ผู้โจมตีส่ง `patientId = "0 OR 1=1"` → ดึงข้อมูลทุก row

**Bug 2 — Race Condition** (Read-Check-Write ไม่ atomic)
```
Request A: อ่านยอดเหลือ 1000 บาท
Request B: อ่านยอดเหลือ 1000 บาท  ← ยังไม่เห็นการอัปเดตของ A
Request A: เบิก 800 บาท → เหลือ 200 บาท
Request B: เบิก 800 บาท → เหลือ 200 บาท  ← เบิกเกินวงเงิน!
```

**วิธีแก้:**
- Parameterized Query → ป้องกัน SQL Injection
- `SELECT ... FOR UPDATE` + Transaction → ป้องกัน Race Condition

---

## Q4 — Drug Allergy & Safety Design

**ไฟล์:** `Q4_Drug_Allergy/drug_allergy.ts`

ระบบตรวจสอบการแพ้ยาก่อนสั่งจ่าย พร้อมกลไก Override ตามสิทธิ์

**Business Rules:**
| Severity | ต้องการ Override Role |
|----------|----------------------|
| mild | standard doctor |
| moderate | senior doctor |
| severe | head doctor |
| anaphylaxis | ไม่สามารถ override ได้ (HARD BLOCK) |

**ฟีเจอร์หลัก:**
- ตรวจสอบทั้งการแพ้ยาเฉพาะตัวและการแพ้ยาทั้งกลุ่ม (Drug Class Allergy)
- Audit Log ทุก override
- Transaction-safe เพื่อความปลอดภัยของข้อมูล

---

## Q5 — Lab Results Scalability (X-Ray Image)

**ไฟล์:** `Q5_Lab_Scalability/lab_scalability.ts`

ออกแบบระบบส่งภาพ X-Ray ให้รับโหลดได้จำนวนมาก

**Architecture:**
```
Mobile / Tablet
    ↓ HTTPS only
API Server (RBAC + Signed URL Generator)
    ↓ cache-hit → serve compressed
Internal CDN / Nginx (ward-level cache, TTL 5 min)
    ↓ cache-miss
Object Storage (MinIO / S3-compatible)
    AES-256 at-rest encryption
    Variants: thumbnail | mobile | tablet | original
```

**ฟีเจอร์:**
- RBAC ตรวจสิทธิ์ก่อนออก Signed URL
- Image variants (thumbnail/mobile/tablet/original)
- HMAC-SHA256 Signed URL พร้อม expiry
- CDN caching ลด load บน Object Storage

---

## Q6 — AI Symptom Parser

**ไฟล์:** `Q6_Symptom_Parser/symptom_parser.ts`

แปลงบทสนทนาระหว่างแพทย์กับผู้ป่วย → Structured JSON ด้วย AI

**เทคโนโลยี:** OpenAI API (GPT-4o-mini) ผ่าน OpenRouter

**Output Structure:**
```typescript
interface Symptom {
  description:        string;        // ชื่ออาการ เช่น "ปวดท้อง"
  qualifier:          string | null; // คำขยาย เช่น "บิดๆ"
  location:           string | null; // ตำแหน่ง
  duration:           Duration | null;
  severity:           string | null;
  onset_description:  string | null;
}
```

**Input ตัวอย่าง:** บทสนทนาภาษาไทย (`Q6_Symptom_Parser/transcript.md`)

---

## Q7 — Smart Drug Interaction Checker

**ไฟล์:** `Q7_Drug_Interaction/drug_interaction.ts`

ตรวจสอบปฏิกิริยาระหว่างยา 2 ชนิด โดยใช้ทั้ง Rule-Based DB และ AI

**Flow:**
```
STEP 1 — Rule-Based DB Lookup (Authoritative)
    contraindicated / major → BLOCK (AI ไม่สามารถ override)
    moderate / minor / not found → ไปต่อ STEP 2

STEP 2 — AI Analysis (GPT-4o-mini)
    วิเคราะห์เพิ่มเติม พร้อมคำแนะนำทางคลินิก
    ผลลัพธ์ถูก validate ก่อนนำไปใช้เสมอ
```

**หลักการออกแบบ:** AI ใช้เพื่อ augment ไม่ใช่ replace rule-based system — ความปลอดภัยของผู้ป่วยต้องมาก่อนเสมอ

---

## การรัน

### TypeScript (Q1, Q3–Q7)

```bash
# ติดตั้ง dependencies
npm install

# รัน (ต้องมี ts-node หรือ compile ก่อน)
npx ts-node Q1_Priority_Queue/hospital_queue.ts
```

### SQL (Q2)

```bash
# รันบน PostgreSQL
psql -U postgres -d your_db -f Q2_Doctor_Availability/doctor_availability.sql
```

### Environment Variables (Q6, Q7)

สร้างไฟล์ `.env` ใน directory ที่ต้องการ:
```
OPENROUTER_API_KEY=your_api_key_here
```

---

## Tech Stack

- **Language:** TypeScript, SQL
- **Database:** PostgreSQL
- **Object Storage:** MinIO / S3-compatible
- **AI:** OpenAI API (GPT-4o-mini) via OpenRouter
- **Security:** Parameterized Query, HMAC-SHA256 Signed URL, AES-256 Encryption, RBAC
