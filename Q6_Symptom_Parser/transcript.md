# Transcript: อธิบายการทำงานของ Symptom to Structured Data
### ไฟล์ที่ใช้ประกอบ: `symptom_parser.ts`

---

## เริ่มต้นที่โจทย์ก่อนเลย

โจทย์ข้อนี้มีสองส่วน ส่วนแรกคือการเขียน Prompt สำหรับแปลงข้อความอาการของผู้ป่วยให้เป็น JSON เช่น "ปวดท้องบิดๆ มา 2 ชั่วโมง กินส้มตำปูปลาร้ามา" ส่วนที่สองคือการออกแบบ Prompt อย่างไรให้ AI ไม่วินิจฉัยโรคเอง และดึงเฉพาะข้อมูลที่ผู้ป่วยบอกจริงๆ เท่านั้น ไม่เดาหรือเติมเอง

ไฟล์นี้เดินตามลำดับดังนี้ Types ที่บรรทัด 12 ต่อด้วย SYSTEM_PROMPT ที่บรรทัด 52 ซึ่งเป็นส่วนสำคัญที่สุดของโจทย์ แล้วก็ Application Functions ที่บรรทัด 121 ต่อด้วย Validation Layer ที่บรรทัด 153 และปิดท้ายด้วย Test Suite ที่บรรทัด 178

---

## Types — บรรทัด 12–48

เปิดไฟล์มาสิ่งแรกที่เห็นคือ Type definitions สี่อย่าง ได้แก่ interface Duration ที่บรรทัด 12 เก็บระยะเวลาอาการ มี value เป็นตัวเลข unit เป็น minute, hour, day หรือ week และ raw_text เก็บข้อความต้นฉบับเอาไว้

interface Symptom ที่บรรทัด 18 เป็นหน่วยของอาการหนึ่งอาการ มีคอลัมน์ qualifier สำหรับคำขยายเช่น "บิดๆ" และทุกฟิลด์ที่ไม่จำเป็นเป็น null ได้

interface SymptomExtraction ที่บรรทัด 27 เป็น output schema หลักที่บังคับไม่ให้ AI มีพื้นที่ใส่การวินิจฉัย สังเกตว่า interface นี้ไม่มีฟิลด์ diagnosis, disease, condition หรือ assessment เลย ซึ่งเป็น เทคนิคป้องกัน Hallucination ชั้นที่สอง คือถ้า AI ไม่มีที่ใส่ก็ใส่ไม่ได้

---

## SYSTEM_PROMPT — บรรทัด 52–119

นี่คือส่วนที่สำคัญที่สุด Prompt ที่ออกแบบมาใช้เทคนิคป้องกัน Hallucination ห้าชั้นที่แตกต่างกัน

ชั้นที่หนึ่ง Role Anchoring ที่บรรทัด 52 บอกว่า AI คือ SYMPTOM_EXTRACTOR ซึ่งเป็น "structured data extraction API" ไม่ใช่แพทย์ การบอก Role ที่แคบและเฉพาะเจาะจงช่วยจำกัดกรอบการคิดของ AI ให้อยู่แค่การดึงข้อมูล ไม่ใช่การวิเคราะห์ทางการแพทย์

ชั้นที่สอง Schema Constraint ที่บรรทัด 58 กำหนด JSON Schema ที่ AI ต้องตอบ โดย Schema นี้ไม่มีฟิลด์ diagnosis, disease หรือ condition เลย ซึ่งหมายความว่า AI ไม่มีที่ใส่การวินิจฉัย แม้จะ "รู้" คำตอบก็ตาม

ชั้นที่สาม Explicit Prohibition ที่บรรทัด 86 ใช้คำว่า ABSOLUTE PROHIBITIONS แล้วระบุ key ต้องห้ามทั้งหมด ได้แก่ diagnosis, disease, condition, assessment, impression, cause, etiology, differential, probable_cause, likely_cause และ suspected ทั้งหมดนี้ถูก list ไว้ชัดเจน ไม่ให้ AI ตีความเอาเอง

ชั้นที่สี่ Explicit Examples ที่บรรทัด 94 ซึ่งสำคัญมาก Prompt ยกตัวอย่างเฉพาะเจาะจงว่า "กินส้มตำปูปลาร้า" ต้องแปลเป็น recent_food เท่านั้น ไม่ใช่ cause หรือ food poisoning และ "ปวดท้องบิดๆ" ต้องแปลเป็น symptom description และ qualifier เท่านั้น ไม่ใช่ gastroenteritis หรือ colitis เหตุที่ต้องยกตัวอย่างเฉพาะเจาะจงเพราะ AI รู้ว่าส้มตำปูปลาร้ามักทำให้ปวดท้อง ถ้าไม่ห้ามชัดเจน AI จะเติม food poisoning เอง

ชั้นที่ห้าคือ Null-First Policy ที่บรรทัด 93 บอกว่าถ้าไม่มีข้อมูลในข้อความให้ใส่ null เสมอ ห้ามเดา ห้ามอนุมาน

---

## Application Functions — บรรทัด 121–150

ฟังก์ชัน buildUserPrompt ที่บรรทัด 121 สร้าง User Message ที่ครอบข้อความผู้ป่วยด้วย quotation marks เพื่อให้ AI แยกแยะได้ชัดว่าส่วนไหนคือข้อมูลที่ต้องแปลง

ฟังก์ชัน extractSymptoms ที่บรรทัด 125 เรียก OpenRouter API ด้วยการตั้งค่า temperature เป็น 0 ที่บรรทัด 130 ซึ่งเป็นการป้องกัน Hallucination ชั้นเพิ่มเติม เพราะ temperature 0 ทำให้ output deterministic ลดโอกาส AI "สร้างสรรค์" เพิ่มข้อมูลที่ไม่มีในต้นฉบับ บรรทัด 141 ลอก markdown code block ออกก่อน parse เพราะ model บางรุ่นใส่ ```json มาด้วย

---

## Validation Layer — บรรทัด 153–175

นี่คือ เทคนิคป้องกัน Hallucination ชั้นที่ห้า ซึ่งทำงานฝั่ง Application ไม่ใช่ฝั่ง Prompt

ตัวแปร FORBIDDEN_KEYS ที่บรรทัด 153 เก็บรายชื่อ key ต้องห้ามทั้งหมด 12 คำ

ฟังก์ชัน validateExtraction ที่บรรทัด 162 ตรวจทั้ง key และ value ใน JSON output แบบ recursive ถ้า AI แอบใส่ diagnosis ไว้ใน key ที่ไม่รู้จักหรือใน string value ก็จะถูกจับได้ที่นี่ก่อนที่จะบันทึกลง Database

การออกแบบ Defense-in-Depth แบบนี้ทำให้ระบบรับมือได้แม้ Prompt เพียงชั้นเดียวจะไม่เพียงพอ

---

## Test Suite — บรรทัด 178 เป็นต้นไป

Test มีหกกลุ่ม

Test 1 เรียก extractSymptoms แล้วพิมพ์ JSON output ที่ได้จริงจาก model เพื่อให้เห็นว่า output มีรูปแบบถูกต้อง

Test 2 ตรวจว่า symptoms array มีอาการอย่างน้อยหนึ่งอย่าง description มีคำว่า "ปวดท้อง" qualifier เป็น "บิดๆ" duration.value เป็น 2 และ duration.unit เป็น "hour"

Test 3 ตรวจว่า recent_food เป็น array และมีคำว่า "ส้มตำ" โดยไม่มีการอ้างถึงโรคหรือสาเหตุ

Test 4 ตรวจ Null-First Policy ว่า severity เป็น null เพราะผู้ป่วยไม่ได้บอกว่าปวดมากหรือน้อย และ medications กับ allergies เป็น null เพราะไม่ได้พูดถึง

Test 5 คือหัวใจของการป้องกัน Hallucination เรียก validateExtraction แล้วตรวจว่าไม่มี forbidden key ใดเลย และตรวจ string ว่าไม่มีคำว่า food poison, อาหารเป็นพิษ หรือ gastroenteritis ปรากฏใน output

Test 6 ตรวจว่า source_text ใน output ตรงกับข้อความ input โดยไม่มีการเปลี่ยนแปลง

---

## สรุปเทคนิคป้องกัน Hallucination ทั้งห้าชั้น

ชั้นที่หนึ่ง Role Anchoring ที่บรรทัด 52 บอก AI ว่าเป็น extraction API ไม่ใช่แพทย์ จำกัดกรอบการคิด

ชั้นที่สอง Schema Constraint ที่บรรทัด 27 ออกแบบ TypeScript interface ไม่ให้มีฟิลด์ diagnosis ทำให้ AI ไม่มีพื้นที่ใส่การวินิจฉัย

ชั้นที่สาม Explicit Prohibition ที่บรรทัด 86 ระบุ key ต้องห้ามไว้อย่างชัดเจน

ชั้นที่สี่ Concrete Examples ที่บรรทัด 94 ยกตัวอย่างเฉพาะเจาะจงว่าห้ามอนุมาน food poisoning จากส้มตำปูปลาร้า

ชั้นที่ห้า Application Validation ที่บรรทัด 162 ตรวจ output อีกรอบฝั่ง Application ก่อนบันทึก Database ทำให้แม้ Prompt พลาดก็มีด่านสุดท้ายคอยดักอยู่
