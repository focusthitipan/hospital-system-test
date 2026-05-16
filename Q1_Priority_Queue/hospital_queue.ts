// ============================================================
// Hospital Intelligent Priority Queue
// ============================================================

interface Patient {
  id: string;
  type: 'E' | 'N';    // E = Emergency, N = Normal
  severity: number;    // 1–10
  arrivalTime: number; // นาที (นับจาก epoch ใดก็ได้ เช่น นาทีจาก midnight)
}

const WAIT_THRESHOLD_MINUTES = 60;

// ─── Helper: คำนวณ effective level ณ เวลาปัจจุบัน ───────────────────────────

function getEffectiveLevel(patient: Patient, currentTime: number): 'E' | 'N' {
  if (patient.type === 'E') return 'E';
  // Normal ที่รอเกิน 60 นาที → ได้รับการยก priority เป็น Emergency ชั่วคราว
  return (currentTime - patient.arrivalTime) > WAIT_THRESHOLD_MINUTES ? 'E' : 'N';
}

/**
 * เปรียบเทียบความเร่งด่วนระหว่างผู้ป่วย 2 คน
 * ส่งค่า  > 0  ถ้า a เร่งด่วนกว่า b
 *          < 0  ถ้า b เร่งด่วนกว่า a
 *            0  ถ้าเท่ากัน
 */
function compareUrgency(a: Patient, b: Patient, currentTime: number): number {
  const la = getEffectiveLevel(a, currentTime);
  const lb = getEffectiveLevel(b, currentTime);

  if (la !== lb) return la === 'E' ? 1 : -1; // Emergency มาก่อน Normal เสมอ
  return a.severity - b.severity;             // Severity สูงกว่าชนะ
}

// ─── ฟังก์ชันหลัก: Linear Scan O(n) ─────────────────────────────────────────

/**
 * หาผู้ป่วยที่เร่งด่วนที่สุดในคิว
 *
 * Time Complexity : O(n)  — วนลูปครั้งเดียวผ่านทุก element
 * Space Complexity: O(1)  — ไม่ใช้หน่วยความจำเพิ่มเติม
 */
function getUrgentPatient(queue: Patient[], currentTime: number): Patient | null {
  if (queue.length === 0) return null;

  let best = queue[0];
  for (let i = 1; i < queue.length; i++) {
    if (compareUrgency(queue[i], best, currentTime) > 0) {
      best = queue[i];
    }
  }
  return best;
}

// ─── Max-Heap Priority Queue สำหรับระบบ Dynamic ─────────────────────────────

/**
 * HospitalPriorityQueue ใช้ Max-Heap ภายใน
 *
 * ปัญหาของ Dynamic Priority:
 *   เมื่อเวลาผ่านไป Normal ที่รอเกิน 60 นาทีจะถูก elevate เป็น E
 *   ทำให้ heap property อาจไม่ valid อีกต่อไป
 *
 * วิธีแก้ที่ใช้ที่นี่:
 *   - enqueue          : O(log n)
 *   - dequeueUrgent    : O(n) — scan เพื่อรองรับ dynamic elevation
 *   - advanceTime      : O(n) — rebuild heap เมื่อเวลาเปลี่ยน
 */
class HospitalPriorityQueue {
  private heap: Patient[] = [];
  private currentTime: number;

  constructor(initialTime: number) {
    this.currentTime = initialTime;
  }

  get size(): number {
    return this.heap.length;
  }

  /** เพิ่มผู้ป่วยเข้าคิว — O(log n) */
  enqueue(patient: Patient): void {
    this.heap.push(patient);
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * ดึงผู้ป่วยที่เร่งด่วนที่สุดออกจากคิว
   * O(n) — เพราะต้องตรวจ dynamic elevation ของทุก node
   */
  dequeueUrgent(): Patient | null {
    if (this.heap.length === 0) return null;

    let bestIdx = 0;
    for (let i = 1; i < this.heap.length; i++) {
      if (compareUrgency(this.heap[i], this.heap[bestIdx], this.currentTime) > 0) {
        bestIdx = i;
      }
    }
    return this.removeAt(bestIdx);
  }

  /** ดูผู้ป่วยที่เร่งด่วนที่สุดโดยไม่ลบออก — O(n) */
  peek(): Patient | null {
    return getUrgentPatient(this.heap, this.currentTime);
  }

  /**
   * อัปเดตเวลาปัจจุบัน แล้ว rebuild heap
   * ควรเรียกก่อน dequeueUrgent เมื่อเวลาเปลี่ยน — O(n)
   */
  advanceTime(newTime: number): void {
    this.currentTime = newTime;
    this.buildHeap();
  }

  // ─── Internal heap helpers ──────────────────────────────────────────────────

  private cmp(i: number, j: number): number {
    return compareUrgency(this.heap[i], this.heap[j], this.currentTime);
  }

  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.cmp(idx, parent) > 0) { this.swap(idx, parent); idx = parent; }
      else break;
    }
  }

  private siftDown(idx: number): void {
    const n = this.heap.length;
    while (true) {
      let largest = idx;
      const l = 2 * idx + 1;
      const r = 2 * idx + 2;
      if (l < n && this.cmp(l, largest) > 0) largest = l;
      if (r < n && this.cmp(r, largest) > 0) largest = r;
      if (largest === idx) break;
      this.swap(idx, largest);
      idx = largest;
    }
  }

  private buildHeap(): void {
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  private removeAt(idx: number): Patient {
    const removed = this.heap[idx];
    const last = this.heap.pop()!;
    if (idx < this.heap.length) {
      this.heap[idx] = last;
      this.bubbleUp(idx);
      this.siftDown(idx);
    }
    return removed;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'} — ${message}`);
}

function runTests(): void {
  console.log('=== Test Suite ===\n');

  // currentTime = 120 นาที
  const t = 120;

  // ─── Test 1: Emergency มาก่อน Normal ────────────────────────────────────
  console.log('Test 1: Emergency beats Normal');
  const q1: Patient[] = [
    { id: 'N1', type: 'N', severity: 10, arrivalTime: 100 }, // N, รอ 20 นาที
    { id: 'E1', type: 'E', severity: 1,  arrivalTime: 119 }, // E, severity ต่ำ
  ];
  const r1 = getUrgentPatient(q1, t);
  assert(r1?.id === 'E1', `Emergency (E1) ต้องมาก่อน Normal severity 10 → got ${r1?.id}`);

  // ─── Test 2: Severity สูงกว่าชนะในกลุ่มเดียวกัน ─────────────────────────
  console.log('\nTest 2: Higher severity wins within same group');
  const q2: Patient[] = [
    { id: 'E1', type: 'E', severity: 5, arrivalTime: 100 },
    { id: 'E2', type: 'E', severity: 9, arrivalTime: 100 },
    { id: 'E3', type: 'E', severity: 3, arrivalTime: 100 },
  ];
  const r2 = getUrgentPatient(q2, t);
  assert(r2?.id === 'E2', `E2 (severity 9) ต้องชนะ → got ${r2?.id}`);

  // ─── Test 3: Wait-Time Elevation ─────────────────────────────────────────
  console.log('\nTest 3: Normal > 60 min gets elevated to Emergency');
  const q3: Patient[] = [
    { id: 'N1', type: 'N', severity: 4, arrivalTime: 50  }, // รอ 70 นาที → Elevated E
    { id: 'E1', type: 'E', severity: 3, arrivalTime: 100 }, // E, severity 3
  ];
  assert(getEffectiveLevel(q3[0], t) === 'E', `N1 รอ 70 นาที → effective level ต้องเป็น E`);
  const r3 = getUrgentPatient(q3, t);
  assert(r3?.id === 'N1', `N1 (elevated E, severity 4) ต้องชนะ E1 (severity 3) → got ${r3?.id}`);

  // ─── Test 4: Elevated Normal vs Emergency severity comparison ────────────
  console.log('\nTest 4: Elevated Normal vs Emergency — severity decides');
  const q4: Patient[] = [
    { id: 'N1', type: 'N', severity: 9, arrivalTime: 50  }, // elevated E, severity 9
    { id: 'E1', type: 'E', severity: 7, arrivalTime: 100 }, // E, severity 7
  ];
  const r4 = getUrgentPatient(q4, t);
  assert(r4?.id === 'N1', `Elevated N1 (severity 9) ต้องชนะ E1 (severity 7) → got ${r4?.id}`);

  // ─── Test 5: Empty queue ──────────────────────────────────────────────────
  console.log('\nTest 5: Empty queue returns null');
  assert(getUrgentPatient([], t) === null, 'Queue ว่างต้อง return null');

  // ─── Test 6: HospitalPriorityQueue dynamic dequeue ────────────────────────
  console.log('\nTest 6: Dynamic PriorityQueue dequeue order');
  const pq = new HospitalPriorityQueue(100);
  pq.enqueue({ id: 'A', type: 'N', severity: 6, arrivalTime: 10  }); // รอ 90 นาที → Elevated E
  pq.enqueue({ id: 'B', type: 'E', severity: 4, arrivalTime: 80  }); // E, severity 4
  pq.enqueue({ id: 'C', type: 'E', severity: 8, arrivalTime: 95  }); // E, severity 8 ← อันดับ 1
  pq.enqueue({ id: 'D', type: 'N', severity: 9, arrivalTime: 90  }); // รอ 10 นาที → Normal

  const d1 = pq.dequeueUrgent(); // ควรได้ C (E, severity 8)
  const d2 = pq.dequeueUrgent(); // ควรได้ A (Elevated E, severity 6)
  const d3 = pq.dequeueUrgent(); // ควรได้ B (E, severity 4)
  const d4 = pq.dequeueUrgent(); // ควรได้ D (N, severity 9)

  assert(d1?.id === 'C', `1st: expected C → got ${d1?.id}`);
  assert(d2?.id === 'A', `2nd: expected A (elevated) → got ${d2?.id}`);
  assert(d3?.id === 'B', `3rd: expected B → got ${d3?.id}`);
  assert(d4?.id === 'D', `4th: expected D → got ${d4?.id}`);

  // ─── Test 7: 10,000 patients performance ─────────────────────────────────
  console.log('\nTest 7: Performance — 10,000 patients');
  const bigQueue: Patient[] = Array.from({ length: 10_000 }, (_, i) => ({
    id: `P${i}`,
    type: (i % 5 === 0 ? 'E' : 'N') as 'E' | 'N',
    severity: (i % 10) + 1,
    arrivalTime: i % 200, // บางคนรอนานเกิน 60 นาที
  }));

  const start = performance.now();
  const winner = getUrgentPatient(bigQueue, 300);
  const elapsed = performance.now() - start;

  console.log(`  Most urgent: ${winner?.id} | type: ${winner?.type} | severity: ${winner?.severity}`);
  console.log(`  Time elapsed: ${elapsed.toFixed(3)} ms`);
  assert(elapsed < 10, `ต้องทำงานได้ภายใน 10 ms → ใช้ ${elapsed.toFixed(3)} ms`);

  console.log('\n=== Done ===');
}

/*
 * ─── Time Complexity Analysis ───────────────────────────────────────────────
 *
 * [getUrgentPatient — Linear Scan]
 *
 *   Time : O(n)  สำหรับผู้ป่วย 10,000 คน = ~10,000 comparisons
 *   Space: O(1)  ไม่มีหน่วยความจำเพิ่มเติม
 *
 *   ทำงานเร็วมากในทางปฏิบัติ:
 *   - Modern CPU ทำ ~10^9 operations/sec
 *   - 10,000 comparisons ≈ 0.01 ms  ✓
 *
 * [HospitalPriorityQueue — Max-Heap]
 *
 *   enqueue       : O(log n) — heap insert มาตรฐาน
 *   dequeueUrgent : O(n)     — ต้อง scan เพราะ dynamic elevation
 *   advanceTime   : O(n)     — rebuild heap (Floyd's algorithm)
 *
 *   ทำไม dequeueUrgent ถึง O(n) ไม่ใช่ O(log n)?
 *   เพราะ Wait-Time Elevation เปลี่ยน priority แบบ dynamic ตามเวลา
 *   heap property อาจ invalid เมื่อ Normal กลายเป็น Emergency
 *   จึงต้อง linear scan เพื่อหา true maximum
 *
 * [วิธีทำให้ O(log n) ทุก operation — Two-Heap Approach]
 *
 *   แยกเป็น 2 heap:
 *   1. emergencyHeap  : E + Elevated Normal (sorted by severity desc)
 *   2. normalHeap     : Normal ที่ยังไม่ expired (sorted by arrival asc + severity desc)
 *
 *   เมื่อดึงผู้ป่วย:
 *   - ตรวจ normalHeap top ว่า arrivalTime + 60 <= currentTime หรือไม่
 *   - ถ้าใช่ → ย้ายไป emergencyHeap ก่อน (O(log n))
 *   - ดึงจาก emergencyHeap (O(log n))
 *   ผลลัพธ์: O(log n) amortized per dequeue  ✓
 *
 * [สรุปสำหรับ 10,000 คน]
 *
 *   Linear scan     : ~0.01 ms  — เร็วมาก เหมาะกับ one-shot query
 *   Two-Heap        : O(log n) ≈ 13 operations — เหมาะกับ high-frequency enqueue/dequeue
 */

runTests();
