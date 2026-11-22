// The database driver is a bundled copy in /vendor, so no 'npm install' step is needed.
import { neon } from '../../vendor/neon-serverless.mjs';

// The database connection is created on the first request (not when the file
// loads) so the same code runs on both Netlify and Cloudflare.
let _sql = null;
function getSql() {
  if (!_sql) {
    const url = (typeof process !== 'undefined' && process.env && process.env.DATABASE_URL) || globalThis.__DATABASE_URL;
    _sql = neon(url);
  }
  return _sql;
}
const sql = (...args) => getSql()(...args);

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function ok(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}
function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers });
}


// ---- Yearly enrollment records (a student's ID never changes; grade/class per year lives here) ----
async function latestYear() {
  try {
    const r = await sql`SELECT MAX(academic_year) AS y FROM student_enrollments`;
    return (r[0] && r[0].y) || '2026-2027';
  } catch (e) { return '2026-2027'; }
}
async function saveEnrollment(studentId, academicYear, gradeLevel, className) {
  try {
    await sql`
      INSERT INTO student_enrollments (student_id, academic_year, grade_level, class_name)
      VALUES (${studentId}, ${academicYear}, ${gradeLevel}, ${className})
      ON CONFLICT (student_id, academic_year)
      DO UPDATE SET grade_level = EXCLUDED.grade_level, class_name = EXCLUDED.class_name
    `;
  } catch (e) { console.error('Enrollment save error:', e); }
}

// ---------------------------------------------------------------------------
// Individual action handlers (logic copied 1:1 from the original functions)
// ---------------------------------------------------------------------------

async function addMarks(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const body = await req.json();
    const { studentId, subject, score, academicYear, term } = body;
    const numScore = parseInt(score);
    const grade = numScore >= 50 ? 'P' : 'F';

    if (!studentId || !subject || isNaN(numScore) || !academicYear || !term) {
      return err('Missing fields', 400);
    }
    if (numScore < 0 || numScore > 100) {
      return err('Score must be between 0 and 100', 400);
    }

    await sql`
      INSERT INTO results (student_id, subject, score, grade, academic_year, term)
      VALUES (${studentId}, ${subject}, ${numScore}, ${grade}, ${academicYear}, ${term})
      ON CONFLICT (student_id, subject, academic_year, term)
      DO UPDATE SET score = EXCLUDED.score, grade = EXCLUDED.grade
    `;

    return ok({ success: true });
  } catch (error) {
    console.error('Add marks error:', error);
    return err(error.message || 'Server error', 500);
  }
}

async function addStudent(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const {
      studentId,
      fullName,
      password,
      gradeLevel,
      className,
      dateOfBirth,
      guardianName,
      guardianPhone,
      studentPhone,
      address,
      academicYear
    } = await req.json();

    if (!studentId || !fullName || !password || gradeLevel === undefined || gradeLevel === null || gradeLevel === '' || !className) {
      return err('All required fields must be filled', 400);
    }

    const [existing] = await sql`
      SELECT student_id FROM students WHERE student_id = ${studentId}
    `;
    if (existing) {
      return err('Student ID already exists', 409);
    }

    await sql`
      INSERT INTO students (
        student_id,
        full_name,
        password,
        grade_level,
        class_name,
        date_of_birth,
        guardian_name,
        guardian_phone,
        student_phone,
        address
      )
      VALUES (
        ${studentId},
        ${fullName},
        ${password},
        ${parseInt(gradeLevel)},
        ${className},
        ${dateOfBirth || null},
        ${guardianName || null},
        ${guardianPhone || null},
        ${studentPhone || null},
        ${address || null}
      )
    `;

    await saveEnrollment(studentId, academicYear || await latestYear(), parseInt(gradeLevel), className);

    return ok({ success: true, message: `Student ${fullName} added successfully` });
  } catch (error) {
    console.error('Add student error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function adminLogin(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const { username, password } = await req.json();
    if (!username || !password) {
      return err('Username and password are required', 400);
    }

    const [admin] = await sql`
      SELECT id, username FROM admin
      WHERE username = ${username} AND password = ${password}
    `;
    if (!admin) {
      return err('Invalid username or password', 401);
    }

    return ok({ success: true, admin: { id: admin.id, username: admin.username } });
  } catch (error) {
    console.error('Admin login error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function bulkUploadResults(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const { results, academicYear, term } = await req.json();
    if (!results || !Array.isArray(results) || !academicYear || !term) {
      return err('Missing required fields', 400);
    }

    let saved = 0;
    let failed = 0;
    const errors = [];

    for (const r of results) {
      const { studentId, subject, score } = r;
      if (!studentId || !subject || score === undefined) {
        failed++;
        errors.push(`Missing fields for one row`);
        continue;
      }
      if (score < 0 || score > 100) {
        failed++;
        errors.push(`Invalid score for ${studentId}`);
        continue;
      }

      const grade = score >= 50 ? 'P' : 'F';

      try {
        const [student] = await sql`
          SELECT student_id FROM students WHERE student_id = ${studentId}
        `;
        if (!student) {
          failed++;
          errors.push(`Student ${studentId} not found`);
          continue;
        }

        const [existing] = await sql`
          SELECT id FROM results
          WHERE student_id = ${studentId}
            AND subject = ${subject}
            AND academic_year = ${academicYear}
            AND term = ${term}
        `;

        if (existing) {
          await sql`
            UPDATE results
            SET score = ${score}, grade = ${grade}
            WHERE student_id = ${studentId}
              AND subject = ${subject}
              AND academic_year = ${academicYear}
              AND term = ${term}
          `;
        } else {
          await sql`
            INSERT INTO results (student_id, subject, score, grade, academic_year, term)
            VALUES (${studentId}, ${subject}, ${score}, ${grade}, ${academicYear}, ${term})
          `;
        }
        saved++;
      } catch (rowErr) {
        failed++;
        errors.push(`Error saving ${studentId}: ${rowErr.message}`);
      }
    }

    return ok({
      success: true,
      message: `تم حفظ ${saved} نتيجة بنجاح${failed ? `، فشل ${failed}` : ''}`,
      total: saved,
      failed,
      errors
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function deleteResults(req) {
  if (req.method !== 'DELETE') return err('Method not allowed', 405);
  try {
    const { studentId, subject, academicYear, term } = await req.json();
    if (!studentId) {
      return err('Student ID is required', 400);
    }

    const [student] = await sql`
      SELECT student_id FROM students WHERE student_id = ${studentId}
    `;
    if (!student) {
      return err(`Student ID ${studentId} not found`, 404);
    }

    if (subject && academicYear && term) {
      await sql`
        DELETE FROM results
        WHERE student_id = ${studentId}
          AND subject = ${subject}
          AND academic_year = ${academicYear}
          AND term = ${term}
      `;
    } else {
      await sql`
        DELETE FROM results
        WHERE student_id = ${studentId}
      `;
    }

    return ok({ success: true, message: 'Results deleted successfully' });
  } catch (error) {
    console.error('Delete results error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function deleteStudent(req) {
  if (req.method !== 'DELETE') return err('Method not allowed', 405);
  try {
    const { studentId } = await req.json();
    if (!studentId) {
      return err('Student ID is required', 400);
    }

    const [student] = await sql`
      SELECT student_id, full_name FROM students WHERE student_id = ${studentId}
    `;
    if (!student) {
      return err(`Student ID ${studentId} not found`, 404);
    }

    await sql`DELETE FROM results WHERE student_id = ${studentId}`;
    try { await sql`DELETE FROM student_enrollments WHERE student_id = ${studentId}`; } catch (e) { console.error(e); }
    await sql`DELETE FROM students WHERE student_id = ${studentId}`;

    return ok({
      success: true,
      message: `Student ${student.full_name} (${studentId}) and all their results have been deleted successfully`
    });
  } catch (error) {
    console.error('Delete student error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function getAllResults(req) {
  if (req.method !== 'GET') return err('Method not allowed', 405);
  try {
    const url = new URL(req.url);
    const gradeLevel = url.searchParams.get('gradeLevel');
    const className = url.searchParams.get('className');
    const academicYear = url.searchParams.get('academicYear');
    const term = url.searchParams.get('term');

    let query = `
      SELECT r.subject, r.score, r.grade, r.academic_year, r.term,
             s.student_id, s.full_name, s.grade_level, s.class_name
      FROM results r
      JOIN students s ON r.student_id = s.student_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (gradeLevel) {
      query += ` AND s.grade_level = $${paramIndex}`;
      params.push(parseInt(gradeLevel));
      paramIndex++;
    }
    if (className) {
      query += ` AND s.class_name = $${paramIndex}`;
      params.push(className);
      paramIndex++;
    }
    if (academicYear) {
      query += ` AND r.academic_year = $${paramIndex}`;
      params.push(academicYear);
      paramIndex++;
    }
    if (term) {
      query += ` AND r.term = $${paramIndex}`;
      params.push(term);
      paramIndex++;
    }

    query += ` ORDER BY s.grade_level, s.class_name, s.student_id, r.subject`;

    const results = await sql(query, params);
    return ok({ success: true, results });
  } catch (error) {
    console.error('Get all results error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function getAllStudents(req) {
  if (req.method !== 'GET') return err('Method not allowed', 405);
  try {
    const url = new URL(req.url);
    const gradeLevel = url.searchParams.get('gradeLevel');
    const className = url.searchParams.get('className');

    let students;
    if (gradeLevel && className) {
      students = await sql`
        SELECT id, student_id, full_name, grade_level, class_name,
               date_of_birth, guardian_name, guardian_phone, student_phone, address
        FROM students
        WHERE grade_level = ${parseInt(gradeLevel)} AND class_name = ${className}
        ORDER BY grade_level, class_name, student_id
      `;
    } else if (gradeLevel) {
      students = await sql`
        SELECT id, student_id, full_name, grade_level, class_name,
               date_of_birth, guardian_name, guardian_phone, student_phone, address
        FROM students
        WHERE grade_level = ${parseInt(gradeLevel)}
        ORDER BY class_name, student_id
      `;
    } else if (className) {
      students = await sql`
        SELECT id, student_id, full_name, grade_level, class_name,
               date_of_birth, guardian_name, guardian_phone, student_phone, address
        FROM students
        WHERE class_name = ${className}
        ORDER BY grade_level, student_id
      `;
    } else {
      students = await sql`
        SELECT id, student_id, full_name, grade_level, class_name,
               date_of_birth, guardian_name, guardian_phone, student_phone, address
        FROM students
        ORDER BY grade_level, class_name, student_id
      `;
    }

    return ok({ success: true, students });
  } catch (error) {
    console.error('Get all students error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function getClassStats(req) {
  // Note: original function had no explicit method check (responded to any verb) — preserved as-is.
  try {
    const url = new URL(req.url);
    const gradeLevel = url.searchParams.get('gradeLevel');
    const className = url.searchParams.get('className');
    const term = url.searchParams.get('term');
    const academicYear = url.searchParams.get('academicYear');
    const studentId = url.searchParams.get('studentId');

    if (!gradeLevel || !className || !term || !academicYear || !studentId) {
      return err('Missing required parameters', 400);
    }

    // Prefer the class the student was actually in that year (yearly record); fall back to the current class
    let results = [];
    try {
      results = await sql`
        SELECT
          r.student_id,
          SUM(r.score) as total_score,
          COUNT(r.subject) as subject_count,
          SUM(CASE WHEN r.score >= 50 THEN 1 ELSE 0 END) as passed_subjects,
          COUNT(r.subject) as total_subjects
        FROM results r
        JOIN student_enrollments e ON e.student_id = r.student_id AND e.academic_year = r.academic_year
        WHERE e.grade_level = ${parseInt(gradeLevel)}
          AND e.class_name = ${className}
          AND r.term = ${term}
          AND r.academic_year = ${academicYear}
        GROUP BY r.student_id
        ORDER BY total_score DESC
      `;
    } catch (e) { console.error('class-stats enrollment query failed:', e); }
    if (!results.length) results = await sql`
      SELECT
        r.student_id,
        SUM(r.score) as total_score,
        COUNT(r.subject) as subject_count,
        SUM(CASE WHEN r.score >= 50 THEN 1 ELSE 0 END) as passed_subjects,
        COUNT(r.subject) as total_subjects
      FROM results r
      JOIN students s ON r.student_id = s.student_id
      WHERE s.grade_level = ${parseInt(gradeLevel)}
        AND s.class_name = ${className}
        AND r.term = ${term}
        AND r.academic_year = ${academicYear}
      GROUP BY r.student_id
      ORDER BY total_score DESC
    `;

    if (!results.length) {
      return ok({ success: true, rank: null, classTotal: 0, passTotal: 0 });
    }

    const classTotal = results.length;
    const passTotal = results.filter(
      (r) => parseInt(r.passed_subjects) === parseInt(r.total_subjects)
    ).length;
    const rank = results.findIndex((r) => r.student_id === studentId) + 1;

    return ok({ success: true, rank: rank || null, classTotal, passTotal });
  } catch (error) {
    console.error('get-class-stats error:', error);
    return err('Database error: ' + error.message, 500);
  }
}

async function getResults(req) {
  if (req.method !== 'GET') return err('Method not allowed', 405);
  try {
    const url = new URL(req.url);
    const studentId = url.searchParams.get('studentId');
    if (!studentId) {
      return err('Student ID is required', 400);
    }

    const results = await sql`
      SELECT r.subject, r.score, r.grade, r.academic_year, r.term,
             s.full_name, s.grade_level, s.class_name
      FROM results r
      JOIN students s ON r.student_id = s.student_id
      WHERE r.student_id = ${studentId}
      ORDER BY r.academic_year DESC, r.term, r.subject
    `;

    return ok({ success: true, results });
  } catch (error) {
    console.error('Get results error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function studentLogin(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const { studentId, password, pin, fullName } = await req.json();
    const secret = String(pin || password || '').trim();
    if (!studentId || !secret) {
      return err('يرجى إدخال رقم الطالب وكلمة المرور', 400);
    }

    try { await ensurePinSchema(); } catch (e) { console.error('PIN schema error:', e); }

    let student;
    try {
      [student] = await sql`
        SELECT student_id, full_name, grade_level, class_name, date_of_birth,
               guardian_name, guardian_phone, student_phone, address, profile_photo,
               password, portal_pin
        FROM students
        WHERE UPPER(student_id) = UPPER(${studentId})
      `;
    } catch (e) {
      // PIN column not available: behave exactly like the old login
      [student] = await sql`
        SELECT student_id, full_name, grade_level, class_name, date_of_birth,
               guardian_name, guardian_phone, student_phone, address, profile_photo,
               password, NULL AS portal_pin
        FROM students
        WHERE UPPER(student_id) = UPPER(${studentId})
      `;
    }

    if (!student) {
      return err('رقم الطالب أو كلمة المرور غير صحيحة', 401);
    }

    if (student.portal_pin) {
      // ---- PIN login: full name + student number + PIN ----
      const bucket = 'pin:' + String(student.student_id).toUpperCase();
      const [cnt] = await sql`
        SELECT COUNT(*)::int AS n FROM pin_login_attempts
        WHERE bucket = ${bucket} AND created_at > NOW() - INTERVAL '15 minutes'
      `;
      if (cnt && cnt.n >= 8) {
        return err('محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.', 429);
      }
      if (!fullName || !String(fullName).trim()) {
        return err('اكتب اسمك الكامل مع رقم الطالب ورقم PIN', 400);
      }
      const good = String(student.portal_pin) === secret && nameMatches(fullName, student.full_name);
      if (!good) {
        await sql`INSERT INTO pin_login_attempts (bucket) VALUES (${bucket})`;
        await sql`DELETE FROM pin_login_attempts WHERE created_at < NOW() - INTERVAL '1 day'`;
        return err('الاسم أو رقم الطالب أو رقم PIN غير صحيح', 401);
      }
      await sql`DELETE FROM pin_login_attempts WHERE bucket = ${bucket}`;
    } else if (String(student.password) !== String(password || pin || '').trim()) {
      // ---- students without a PIN keep the old password login ----
      return err('رقم الطالب أو كلمة المرور غير صحيحة', 401);
    }

    let history = [];
    try {
      history = await sql`
        SELECT academic_year, grade_level, class_name
        FROM student_enrollments
        WHERE student_id = ${student.student_id}
        ORDER BY academic_year DESC
      `;
    } catch (e) { console.error('History load error:', e); }

    return ok({
      success: true,
      student: {
        studentId: student.student_id,
        fullName: student.full_name,
        gradeLevel: student.grade_level,
        className: student.class_name,
        dateOfBirth: student.date_of_birth,
        guardianName: student.guardian_name,
        guardianPhone: student.guardian_phone,
        studentPhone: student.student_phone,
        address: student.address,
        profilePhoto: student.profile_photo,
        history
      }
    });
  } catch (error) {
    console.error('Student login error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function resetPassword(req) {
  if (req.method !== 'PUT') return err('Method not allowed', 405);
  try {
    const { studentId, newPassword } = await req.json();
    if (!studentId || !newPassword) {
      return err('Student ID and new password are required', 400);
    }

    const [student] = await sql`
      SELECT student_id FROM students WHERE student_id = ${studentId}
    `;
    if (!student) {
      return err(`Student ID ${studentId} not found`, 404);
    }

    await sql`
      UPDATE students
      SET password = ${newPassword}
      WHERE student_id = ${studentId}
    `;

    return ok({ success: true, message: `Password reset successfully for ${studentId}` });
  } catch (error) {
    console.error('Reset password error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function updateStudent(req) {
  if (req.method !== 'PUT') return err('Method not allowed', 405);
  try {
    const {
      studentId,
      fullName,
      gradeLevel,
      className,
      dateOfBirth,
      guardianName,
      guardianPhone,
      studentPhone,
      address,
      academicYear
    } = await req.json();

    if (!studentId) {
      return err('Student ID is required', 400);
    }

    const [student] = await sql`
      SELECT student_id FROM students WHERE student_id = ${studentId}
    `;
    if (!student) {
      return err(`Student ID ${studentId} not found`, 404);
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (fullName !== undefined && fullName !== '') {
      updates.push(`full_name = $${paramIndex++}`);
      params.push(fullName);
    }
    if (gradeLevel !== undefined && gradeLevel !== '') {
      updates.push(`grade_level = $${paramIndex++}`);
      params.push(parseInt(gradeLevel));
    }
    if (className !== undefined && className !== '') {
      updates.push(`class_name = $${paramIndex++}`);
      params.push(className);
    }
    if (dateOfBirth !== undefined && dateOfBirth !== '') {
      updates.push(`date_of_birth = $${paramIndex++}`);
      params.push(dateOfBirth);
    }
    if (guardianName !== undefined && guardianName !== '') {
      updates.push(`guardian_name = $${paramIndex++}`);
      params.push(guardianName);
    }
    if (guardianPhone !== undefined && guardianPhone !== '') {
      updates.push(`guardian_phone = $${paramIndex++}`);
      params.push(guardianPhone);
    }
    if (studentPhone !== undefined && studentPhone !== '') {
      updates.push(`student_phone = $${paramIndex++}`);
      params.push(studentPhone);
    }
    if (address !== undefined && address !== '') {
      updates.push(`address = $${paramIndex++}`);
      params.push(address);
    }

    if (updates.length === 0) {
      return err('No fields to update', 400);
    }

    params.push(studentId);
    const query = `UPDATE students SET ${updates.join(', ')} WHERE student_id = $${paramIndex}`;
    await sql(query, params);

    // Keep the yearly record in step: a grade/class change is saved for that academic year
    if ((gradeLevel !== undefined && gradeLevel !== '') || (className !== undefined && className !== '')) {
      const [cur] = await sql`SELECT grade_level, class_name FROM students WHERE student_id = ${studentId}`;
      await saveEnrollment(studentId, academicYear || await latestYear(), cur.grade_level, cur.class_name);
    }

    return ok({ success: true, message: 'Student updated successfully' });
  } catch (error) {
    console.error('Update student error:', error);
    return err('Server error. Please try again.', 500);
  }
}

async function uploadPhoto(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const { studentId, photoDataUrl } = await req.json();
    if (!studentId || !photoDataUrl) {
      return err('studentId and photoDataUrl are required', 400);
    }
    if (!photoDataUrl.startsWith('data:image/')) {
      return err('photoDataUrl must be a valid image data URL', 400);
    }
    if (photoDataUrl.length > 750000) {
      return err('الصورة كبيرة جداً. يرجى اختيار صورة أصغر.', 400);
    }

    const result = await sql`
      UPDATE students
      SET profile_photo = ${photoDataUrl}
      WHERE student_id = ${studentId}
      RETURNING student_id
    `;

    if (result.length === 0) {
      return err('Student not found', 404);
    }

    return ok({ success: true, studentId: result[0].student_id });
  } catch (error) {
    console.error('upload-photo error:', error);
    return err('Database error: ' + error.message, 500);
  }
}

// ---------------------------------------------------------------------------
// Student portal PINs (random 6-digit PIN per student, printed on slips)
// ---------------------------------------------------------------------------
let _pinReady = false;
async function ensurePinSchema() {
  if (_pinReady) return;
  await sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_pin TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS students_portal_pin_uq ON students (portal_pin) WHERE portal_pin IS NOT NULL`;
  await sql`CREATE TABLE IF NOT EXISTS pin_login_attempts (
    id SERIAL PRIMARY KEY,
    bucket TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  _pinReady = true;
}

// Arabic-tolerant name comparison (ignores diacritics, hamza/alef forms, ta marbuta, extra spaces)
function normName(s) {
  return String(s || '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function nameMatches(typed, full) {
  const t = normName(typed), f = normName(full);
  if (!t || !f) return false;
  if (t === f || t.replace(/ /g, '') === f.replace(/ /g, '')) return true;
  // at least two words, and they must be the beginning of the registered name
  return t.split(' ').length >= 2 && (f + ' ').startsWith(t + ' ');
}

function randomPin() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

async function checkAdmin(body) {
  const u = body && body.adminUser, p = body && body.adminPass;
  if (!u || !p) return false;
  const r = await sql`SELECT id FROM admin WHERE username = ${u} AND password = ${p}`;
  return r.length > 0;
}

async function generatePins(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const body = await req.json();
    if (!(await checkAdmin(body))) return err('غير مصرح. سجّل الدخول من جديد.', 401);
    await ensurePinSchema();

    const grade = parseInt(body.gradeLevel);
    if (isNaN(grade)) return err('اختر الصف', 400);
    const cls = body.className ? String(body.className).trim() : '';
    const regenerate = body.regenerate === true;

    const rows = cls
      ? await sql`SELECT student_id, portal_pin FROM students
                  WHERE grade_level = ${grade} AND class_name = ${cls} AND archived_at IS NULL`
      : await sql`SELECT student_id, portal_pin FROM students
                  WHERE grade_level = ${grade} AND archived_at IS NULL`;

    const usedRows = await sql`SELECT portal_pin FROM students WHERE portal_pin IS NOT NULL`;
    const used = new Set(usedRows.map(r => r.portal_pin));

    const ids = [], pins = [];
    for (const r of rows) {
      if (r.portal_pin && !regenerate) continue;
      if (r.portal_pin) used.delete(r.portal_pin);
      let pin;
      do { pin = randomPin(); } while (used.has(pin));
      used.add(pin);
      ids.push(r.student_id);
      pins.push(pin);
    }

    if (ids.length) {
      await sql`
        UPDATE students s SET portal_pin = v.pin
        FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${pins}::text[]) AS pin) v
        WHERE s.student_id = v.id
      `;
    }
    return ok({ success: true, generated: ids.length, total: rows.length });
  } catch (error) {
    console.error('Generate PINs error:', error);
    return err(error.message || 'Server error', 500);
  }
}

async function getPinSlips(req) {
  if (req.method !== 'POST') return err('Method not allowed', 405);
  try {
    const body = await req.json();
    if (!(await checkAdmin(body))) return err('غير مصرح. سجّل الدخول من جديد.', 401);
    await ensurePinSchema();

    const grade = parseInt(body.gradeLevel);
    if (isNaN(grade)) return err('اختر الصف', 400);
    const cls = body.className ? String(body.className).trim() : '';

    const rows = cls
      ? await sql`SELECT student_id, full_name, grade_level, class_name, portal_pin FROM students
                  WHERE grade_level = ${grade} AND class_name = ${cls} AND archived_at IS NULL
                  ORDER BY class_name, full_name`
      : await sql`SELECT student_id, full_name, grade_level, class_name, portal_pin FROM students
                  WHERE grade_level = ${grade} AND archived_at IS NULL
                  ORDER BY class_name, full_name`;

    return ok({
      success: true,
      students: rows.map(r => ({
        studentId: r.student_id,
        fullName: r.full_name,
        gradeLevel: r.grade_level,
        className: r.class_name,
        pin: r.portal_pin || null
      }))
    });
  } catch (error) {
    console.error('Get PIN slips error:', error);
    return err(error.message || 'Server error', 500);
  }
}

// ---------------------------------------------------------------------------
// Router — one edge function, dispatched by the last path segment
// ---------------------------------------------------------------------------

// GET /api/health  ->  quick check that the API runs and can reach the database.
async function health(req) {
  const out = { ok: true, api: 'running', databaseUrlSet: false, database: 'not checked' };
  try {
    const url = (typeof process !== 'undefined' && process.env && process.env.DATABASE_URL) || globalThis.__DATABASE_URL;
    out.databaseUrlSet = !!url;
    if (!url) { out.ok = false; out.database = 'DATABASE_URL is missing'; return ok(out, 200); }
    const r = await sql`SELECT COUNT(*)::int AS admins FROM admin`;
    out.database = 'connected';
    out.adminAccounts = r[0].admins;
  } catch (e) {
    out.ok = false;
    out.database = 'error: ' + String((e && e.message) || e).slice(0, 160).replace(/postgres(ql)?:\/\/\S+/gi, '[hidden]');
  }
  return ok(out, 200);
}

const routes = {
  'health': health,
  'add-marks': addMarks,
  'add-student': addStudent,
  'admin-login': adminLogin,
  'bulk-upload-results': bulkUploadResults,
  'delete-results': deleteResults,
  'delete-student': deleteStudent,
  'get-all-results': getAllResults,
  'get-all-students': getAllStudents,
  'get-class-stats': getClassStats,
  'get-results': getResults,
  'student-login': studentLogin,
  'generate-pins': generatePins,
  'get-pin-slips': getPinSlips,
  'reset-password': resetPassword,
  'update-student': updateStudent,
  'upload-photo': uploadPhoto
};

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop();

  const handler = routes[action];
  if (!handler) {
    return err('Unknown API route', 404);
  }

  return handler(req);
};

export const config = {
  path: [
    '/api/add-marks',
    '/api/add-student',
    '/api/admin-login',
    '/api/health',
    '/api/bulk-upload-results',
    '/api/delete-results',
    '/api/delete-student',
    '/api/get-all-results',
    '/api/get-all-students',
    '/api/get-class-stats',
    '/api/get-results',
    '/api/student-login',
    '/api/generate-pins',
    '/api/get-pin-slips',
    '/api/reset-password',
    '/api/update-student',
    '/api/upload-photo'
  ]
};
