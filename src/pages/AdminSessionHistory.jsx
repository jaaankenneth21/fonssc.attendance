import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";
import AdminSidebar from "./AdminSidebar";
import "./admin-dashboard.css";
import "./admin-students.css";
import "./AdminSessionHistory.css";


const TZ = "Asia/Manila";

/* Storage bucket holding the time in / time out photos */
const PHOTO_BUCKET = "attendance-photos";

/* Shades used for the year-level breakdown bar */
const BAR_SHADES = ["#e8946a", "#f2b18a", "#ffc99e", "#d9b8a0", "#c9a58b"];

/* =========================================================
   ICONS (inline SVG, inherits currentColor)
   ========================================================= */

function Icon({ children, size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const IconClock = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

const IconCap = () => (
  <Icon>
    <path d="M22 10 12 5 2 10l10 5 10-5Z" />
    <path d="M6 12v5c3 2 9 2 12 0v-5" />
  </Icon>
);

const IconBell = () => (
  <Icon>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </Icon>
);

const IconTrash = () => (
  <Icon>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </Icon>
);

const IconChevron = () => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

const IconDownload = () => (
  <Icon>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </Icon>
);

/* =========================================================
   HELPERS
   ========================================================= */

function getInitials(name) {
  if (!name) return "?";
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const isDateOnly = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-PH", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

/* Month + day for the date tile, plus a readable weekday line */
function dateParts(p) {
  const source = p.program_date || p.started_at;
  const dateOnly = isDateOnly(source);
  const d = dateOnly ? new Date(`${source}T00:00:00`) : new Date(source);
  const tz = dateOnly ? undefined : TZ;

  if (Number.isNaN(d.getTime())) {
    return { month: "", day: "—", full: "" };
  }

  return {
    month: d.toLocaleDateString("en-PH", { month: "short", timeZone: tz }),
    day: d.toLocaleDateString("en-PH", { day: "numeric", timeZone: tz }),
    full: d.toLocaleDateString("en-PH", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: tz,
    }),
  };
}

function formatDuration(start, end) {
  if (!start || !end) return "";
  const minutes = Math.max(
    0,
    Math.round((new Date(end) - new Date(start)) / 60000)
  );
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/* "open" in the DB but past its deadline is effectively over */
function effectiveStatus(p) {
  if (p.status === "open" && p.deadline && new Date(p.deadline) < new Date()) {
    return "expired";
  }
  return p.status;
}

const STATUS_LABEL = {
  open: "Open now",
  expired: "Ended · deadline passed",
  closed: "Ended",
};

/* Lowercase + trimmed, so "1st Year" matches "1st year " */
const normalize = (v) => String(v ?? "").trim().toLowerCase();

/* Sort by year level (1st, 2nd, 10th...) then by name */
function byYearThenName(a, b) {
  const yearA = a?.year_level || "";
  const yearB = b?.year_level || "";

  return (
    yearA.localeCompare(yearB, undefined, { numeric: true }) ||
    (a?.full_name || "").localeCompare(b?.full_name || "")
  );
}

/* =========================================================
   SECTION TABLE (used for Present / Timed in only / Absent)

   rows: [{ key, student, time_in, time_out }]
   mode: "present" | "timedin" | "absent"
   ========================================================= */

const MODE_BADGE = {
  present: { label: "Present" },
  timedin: { label: "No time out" },
  absent: { label: "Absent" },
};

const IconCheckCircle = () => (
  <Icon size={16}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
  </Icon>
);

const IconHourglass = () => (
  <Icon size={16}>
    <path d="M6 3h12M6 21h12" />
    <path d="M7 3c0 5 3 6 5 9-2 3-5 4-5 9" />
    <path d="M17 3c0 5-3 6-5 9 2 3 5 4 5 9" />
  </Icon>
);

const IconUserX = () => (
  <Icon size={16}>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 21c0-4 3-7 7-7 1.5 0 2.8.4 3.9 1.2" />
    <path d="m17 15 5 5M22 15l-5 5" />
  </Icon>
);

const SECTION_ICON = {
  present: IconCheckCircle,
  timedin: IconHourglass,
  absent: IconUserX,
};

function TimeCell({ value, empty }) {
  if (!value) return <span className="hs-muted">{empty}</span>;
  return <span className="hs-time">{formatTime(value)}</span>;
}

function HistorySection({ title, hint, mode, rows, emptyText, note }) {
  const badge = MODE_BADGE[mode];
  const showTimes = mode !== "absent";
  const SectionIcon = SECTION_ICON[mode];

  return (
    <div className={`hs-sec hs-sec-${mode}`}>
      <div className="hs-sec-head">
        <span className="hs-sec-icon">
          <SectionIcon />
        </span>

        <div className="hs-sec-text">
          <div className="hs-sec-title">
            <h4>{title}</h4>
            <span className="hs-sec-count">{note ? "—" : rows.length}</span>
          </div>
          {hint && <p>{hint}</p>}
        </div>
      </div>

      {note ? (
        <div className="hs-sec-empty">{note}</div>
      ) : rows.length === 0 ? (
        <div className="hs-sec-empty">{emptyText}</div>
      ) : (
        <div className="hs-table-scroll">
          <table className="hs-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Year</th>
                <th>Course and level</th>
                {showTimes && <th>Time in</th>}
                {showTimes && <th>Time out</th>}
                <th>Status</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <div className="hs-student">
                      <span className="hs-student-avatar">
                        {getInitials(row.student?.full_name)}
                      </span>
                      <span className="hs-student-text">
                        <strong>{row.student?.full_name || "Unknown"}</strong>
                        <small>{row.student?.student_id || "—"}</small>
                      </span>
                    </div>
                  </td>

                  <td>
                    <span className="hs-year">
                      {row.student?.year_level || "—"}
                    </span>
                  </td>

                  <td>
                    <span className="hs-chip">
                      {row.student?.section || "—"}
                    </span>
                  </td>

                  {showTimes && (
                    <td>
                      <TimeCell value={row.time_in} empty="—" />
                    </td>
                  )}
                  {showTimes && (
                    <td>
                      <TimeCell value={row.time_out} empty="Not yet" />
                    </td>
                  )}

                  <td>
                    <span className={`hs-badge hs-badge-${mode}`}>
                      <i />
                      {badge.label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* =========================================================
   COMPONENT
   ========================================================= */

function AdminSessionHistory() {
  const [user, setUser] = useState(null);
  const [programs, setPrograms] = useState([]);
  const [students, setStudents] = useState([]);
  const [studentsReady, setStudentsReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [yearFilter, setYearFilter] = useState("all");

  /* { [sessionId]: "present" | "timedin" | "absent" }
     A session's panel is open only while it has an active tab. */
  const [activeTab, setActiveTab] = useState({});

  const [toast, setToast] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadUser();
    loadPrograms();
    loadStudents();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function loadUser() {
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();
    setUser(currentUser);
  }

  async function loadPrograms() {
    try {
      setError("");
      if (!loading) setRefreshing(true);

      const { data, error: programsError } = await supabase
        .from("attendance_programs")
        .select(
          `id, name, program_date, deadline, allowed_year_levels,
           status, started_at, closed_at,
           attendance (
             id, session_number, time_in, time_out, status,
             students ( id, student_id, full_name, year_level, section )
           )`
        )
        .order("started_at", { ascending: false });

      if (programsError) throw programsError;

      let rows = data || [];

      /* Auto-end any session whose deadline has passed */
      const now = new Date();
      const expired = rows.filter(
        (p) => p.status === "open" && p.deadline && new Date(p.deadline) < now
      );

      if (expired.length) {
        await Promise.all(
          expired.map((p) =>
            supabase
              .from("attendance_programs")
              .update({ status: "closed", closed_at: p.deadline })
              .eq("id", p.id)
              .eq("status", "open")
          )
        );

        const expiredIds = new Set(expired.map((p) => p.id));
        rows = rows.map((p) =>
          expiredIds.has(p.id)
            ? { ...p, status: "closed", closed_at: p.deadline }
            : p
        );
      }

      setPrograms(rows);
    } catch (err) {
      console.error("Session history load error:", err);
      setError(err?.message || "Unable to load session history.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  /* Full student list, used to work out who was absent.
     Loaded in pages because Supabase returns at most 1000 rows per request. */
  async function loadStudents() {
    try {
      const pageSize = 1000;
      const all = [];
      let from = 0;

      while (true) {
        const { data, error: studentsError } = await supabase
          .from("students")
          .select("id, student_id, full_name, year_level, section")
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);

        if (studentsError) throw studentsError;

        all.push(...(data || []));

        if (!data || data.length < pageSize) break;

        from += pageSize;
      }

      setStudents(all);
      setStudentsReady(true);
    } catch (err) {
      console.error("Student list load error:", err);
      setStudentsReady(false);
    }
  }

  function refreshAll() {
    loadPrograms();
    loadStudents();
  }

  /* Year levels present in the data (free text column) */
  const yearOptions = useMemo(() => {
    const set = new Set();
    programs.forEach((p) =>
      (p.attendance || []).forEach((a) => {
        if (a.students?.year_level) set.add(a.students.year_level);
      })
    );
    students.forEach((s) => {
      if (s.year_level) set.add(s.year_level);
    });
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
  }, [programs, students]);

  /* Search + year filter. Picking a year level keeps only that
     year level's students inside each session. */
  const visible = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();

    return programs
      .map((p) => {
        const status = effectiveStatus(p);

        /* Absent students are counted once the session has ended,
           either manually closed or because its deadline passed */
        const sessionDone = status === "closed" || status === "expired";

        const attendees = (p.attendance || [])
          .filter(
            (a) => yearFilter === "all" || a.students?.year_level === yearFilter
          )
          .sort((x, y) => new Date(x.time_in) - new Date(y.time_in));

        /* Timed in and timed out */
        const present = attendees
          .filter((a) => a.time_out)
          .sort((x, y) => byYearThenName(x.students, y.students));

        /* Timed in, but no time out */
        const timedInOnly = attendees
          .filter((a) => a.time_in && !a.time_out)
          .sort((x, y) => byYearThenName(x.students, y.students));

        /* Absent = eligible for this session, but no attendance record.
           Uses the session's FULL attendance list (not the year-filtered
           one) so a student is never wrongly marked absent. */
        let absent = [];

        if (sessionDone && studentsReady) {
          const attendedIds = new Set();
          const attendedUsernames = new Set();

          (p.attendance || []).forEach((a) => {
            if (a.students?.id) attendedIds.add(a.students.id);
            if (a.students?.student_id) {
              attendedUsernames.add(a.students.student_id);
            }
          });

          const allowed = new Set(
            (p.allowed_year_levels || []).map(normalize)
          );

          absent = students
            .filter(
              (s) =>
                (allowed.size === 0 || allowed.has(normalize(s.year_level))) &&
                !attendedIds.has(s.id) &&
                !attendedUsernames.has(s.student_id) &&
                (yearFilter === "all" || s.year_level === yearFilter)
            )
            .sort(byYearThenName);
        }

        return {
          ...p,
          _status: status,
          _sessionDone: sessionDone,
          _attendees: attendees,
          _present: present,
          _timedInOnly: timedInOnly,
          _absent: absent,
        };
      })
      .filter((p) => {
        const matchesStudent = (s) =>
          (s?.full_name || "").toLowerCase().includes(search) ||
          (s?.student_id || "").toLowerCase().includes(search);

        const matchesSearch =
          !search ||
          p.name.toLowerCase().includes(search) ||
          p._attendees.some((a) => matchesStudent(a.students)) ||
          p._absent.some((s) => matchesStudent(s));

        const matchesYear =
          yearFilter === "all" ||
          p._attendees.length > 0 ||
          p._absent.length > 0;

        return matchesSearch && matchesYear;
      });
  }, [programs, students, studentsReady, searchTerm, yearFilter]);

  const totalAttendances = visible.reduce((n, p) => n + p._attendees.length, 0);

  /* Chevron: open on Present, or close whatever is open */
  function toggle(id) {
    setActiveTab((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = "present";
      return next;
    });
  }

  /* Category button: open that list, or close it if it's already showing */
  function selectTab(id, tab) {
    setActiveTab((prev) => {
      const next = { ...prev };
      if (next[id] === tab) delete next[id];
      else next[id] = tab;
      return next;
    });
  }

  function yearBreakdown(attendees) {
    const counts = {};
    attendees.forEach((a) => {
      const y = a.students?.year_level || "Unspecified";
      counts[y] = (counts[y] || 0) + 1;
    });
    return Object.entries(counts).sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
  }

  async function handleDeleteSession() {
    if (!deleteTarget) return;

    setDeleting(true);

    try {
      const { data: result, error: deleteError } = await supabase.rpc(
        "delete_attendance_program",
        { p_program_id: deleteTarget.id }
      );

      if (deleteError) throw deleteError;

      setPrograms((prev) => prev.filter((p) => p.id !== deleteTarget.id));

      /* Remove this session's photos from Storage.
         The database function returns the photo paths it just unlinked;
         direct SQL deletes on storage are blocked, so this goes through
         the Storage API. */
      const photoPaths = result?.photo_paths || [];
      let photosRemoved = 0;

      for (let i = 0; i < photoPaths.length; i += 100) {
        const { data: removed, error: removeError } = await supabase.storage
          .from(PHOTO_BUCKET)
          .remove(photoPaths.slice(i, i + 100));

        if (removeError) {
          console.error("Photo cleanup error:", removeError);
        } else {
          photosRemoved += removed?.length || 0;
        }
      }

      const photosLeft = photoPaths.length - photosRemoved;

      setToast(
        photosLeft > 0
          ? `"${deleteTarget.name}" was deleted, but ${photosLeft} photo${
              photosLeft === 1 ? "" : "s"
            } could not be removed from storage.`
          : `"${deleteTarget.name}" was deleted${
              photosRemoved
                ? ` along with ${photosRemoved} photo${
                    photosRemoved === 1 ? "" : "s"
                  }`
                : ""
            }.`
      );
      setDeleteTarget(null);
    } catch (err) {
      console.error("Delete session error:", err);
      setError(err?.message || "Unable to delete this session.");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  /* =======================================================
     EXCEL EXPORT (one session only)
     Three sheets: Present, Timed in only, Absent.
     Students are sorted by year level, then name.
     ======================================================= */

  function exportSession(p) {
    const header = [
      "Username",
      "Student",
      "Year Level",
      "Course and Level",
      "Time In",
      "Time Out",
      "Status",
    ];

    const info = [
      ["Session", p.name],
      ["Date", dateParts(p).full || p.program_date || ""],
      [
        "Started / Ended",
        `${formatDateTime(p.started_at)}${
          p.closed_at ? ` to ${formatDateTime(p.closed_at)}` : " (still open)"
        }`,
      ],
      [
        "Allowed year levels",
        p.allowed_year_levels?.length
          ? p.allowed_year_levels.join(", ")
          : "All year levels",
      ],
      [],
    ];

    const attendanceRow = (a, status) => [
      a.students?.student_id || "",
      a.students?.full_name || "",
      a.students?.year_level || "",
      a.students?.section || "",
      formatDateTime(a.time_in),
      a.time_out ? formatDateTime(a.time_out) : "",
      status,
    ];

    const presentRows = p._present.map((a) => attendanceRow(a, "Present"));
    const timedInRows = p._timedInOnly.map((a) =>
      attendanceRow(a, "Timed in, no time out")
    );
    const absentRows = p._absent.map((s) => [
      s.student_id || "",
      s.full_name || "",
      s.year_level || "",
      s.section || "",
      "",
      "",
      "Absent",
    ]);

    const absentNoteText = absentNote(p);

    const sheets = [
      ["Present", presentRows, "No student has completed time in and time out."],
      ["Timed in only", timedInRows, "Everyone who timed in has also timed out."],
      [
        "Absent",
        absentRows,
        absentNoteText || "No absent students. Everyone eligible timed in.",
      ],
    ];

    const widths = [
      { wch: 16 },
      { wch: 30 },
      { wch: 12 },
      { wch: 22 },
      { wch: 18 },
      { wch: 18 },
      { wch: 22 },
    ];

    const workbook = XLSX.utils.book_new();

    sheets.forEach(([name, rows, emptyMessage]) => {
      const body = rows.length ? rows : [[emptyMessage]];
      const sheet = XLSX.utils.aoa_to_sheet([...info, header, ...body]);
      sheet["!cols"] = widths;
      XLSX.utils.book_append_sheet(workbook, sheet, name);
    });

    const safeName =
      String(p.name || "session")
        .replace(/[^\w\- ]+/g, "")
        .trim()
        .replace(/\s+/g, "-") || "session";

    const datePart = (p.program_date || p.started_at || "").slice(0, 10);

    XLSX.writeFile(
      workbook,
      `${safeName}${datePart ? `-${datePart}` : ""}.xlsx`
    );
  }

  /* Text shown in the Absent section when it can't list anyone yet */
  function absentNote(p) {
    if (!p._sessionDone) {
      return "Absent students will appear once this session has ended.";
    }
    if (!studentsReady) {
      return "Couldn't load the student list. Tap refresh to try again.";
    }
    return "";
  }

  /* =======================================================
     RENDER
     ======================================================= */

  return (
    <div className="admin-page">
      <AdminSidebar user={user} />

      <main className="admin-main">
        <div className="admin-content">
          {/* HEADER */}
          <div className="dashboard-header">
            <div>
              <div className="breadcrumb">
                <span>Dashboard</span>
                <span>/</span>
                <span>Session History</span>
              </div>

              <h1>Session History</h1>
              <p>Every session you've started, with the students who attended.</p>
            </div>
          </div>

          {toast && (
            <div className="dashboard-toast">
              <span>✓</span>
              <span>{toast}</span>
              <button type="button" onClick={() => setToast("")}>
                ×
              </button>
            </div>
          )}

          {error && (
            <div className="dashboard-error">
              <strong>Something went wrong</strong>
              <span>{error}</span>
              <button type="button" onClick={loadPrograms}>
                Try Again
              </button>
            </div>
          )}

          {/* STATS */}
          <section className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon green">◷</div>
              <div className="stat-content">
                <span className="stat-label">SESSIONS</span>
                <strong>{loading ? "—" : visible.length}</strong>
                <small>shown below</small>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon orange">♙</div>
              <div className="stat-content">
                <span className="stat-label">TOTAL ATTENDANCES</span>
                <strong>{loading ? "—" : totalAttendances}</strong>
                <small>across these sessions</small>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon purple">▤</div>
              <div className="stat-content">
                <span className="stat-label">YEAR LEVELS</span>
                <strong>{loading ? "—" : yearOptions.length}</strong>
                <small>represented</small>
              </div>
            </div>
          </section>

          {/* SESSION LOG */}
          <section className="attendance-card">
            <div className="attendance-card-header">
              <div>
                <h2>Session Log</h2>
                <p>
                  Use the Present, Timed in only and Absent buttons on each
                  session to see who is in each group.
                </p>
              </div>

              <div className="attendance-card-actions">
                <button
                  className="refresh-button"
                  type="button"
                  onClick={refreshAll}
                  disabled={refreshing}
                  title="Refresh"
                >
                  ↻
                </button>
              </div>
            </div>

            <div className="attendance-filters">
              <div className="search-box">
                <span>⌕</span>
                <input
                  type="text"
                  placeholder="Search session, name, or username..."
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </div>

              <select
                className="filter-select"
                value={yearFilter}
                onChange={(event) => setYearFilter(event.target.value)}
              >
                <option value="all">All Year Levels</option>
                {yearOptions.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>

            <div className="history-sessions">
              {loading ? (
                <div className="history-empty">
                  <div className="loading-spinner">
                    <span />
                  </div>
                  <strong>Loading sessions...</strong>
                </div>
              ) : visible.length === 0 ? (
                <div className="history-empty">
                  <div className="empty-icon">◷</div>
                  <strong>No sessions found</strong>
                  <span>
                    {programs.length === 0
                      ? "Sessions will appear here after you start one."
                      : "Try a different search or filter."}
                  </span>
                </div>
              ) : (
                visible.map((p) => {
                  const tab = activeTab[p.id];
                  const isOpen = Boolean(tab);
                  const attendees = p._attendees;
                  const status = p._status;
                  const date = dateParts(p);
                  const duration = formatDuration(p.started_at, p.closed_at);
                  const breakdown = yearBreakdown(attendees);
                  const allowed = p.allowed_year_levels?.length
                    ? p.allowed_year_levels.join(", ")
                    : "All year levels";
                  const canDelete = status !== "open";
                  const absentNoteText = absentNote(p);

                  const tabs = [
                    {
                      id: "present",
                      label: "Present",
                      count: p._present.length,
                    },
                    {
                      id: "timedin",
                      label: "Timed in only",
                      count: p._timedInOnly.length,
                    },
                    {
                      id: "absent",
                      label: "Absent",
                      count: absentNoteText ? "—" : p._absent.length,
                    },
                  ];

                  return (
                    <article
                      className={`hs hs-${status}${isOpen ? " is-open" : ""}`}
                      key={p.id}
                    >
                      <div className="hs-top">
                        <div className="hs-date" title={date.full}>
                          <span>{date.month}</span>
                          <strong>{date.day}</strong>
                        </div>

                        <button
                          type="button"
                          className="hs-main"
                          onClick={() => toggle(p.id)}
                          aria-expanded={isOpen}
                        >
                          <span className="hs-title-row">
                            <span className="hs-title">{p.name}</span>
                            <span className="hs-status">
                              <i />
                              {STATUS_LABEL[status] || status}
                            </span>
                          </span>

                          <span className="hs-meta">
                            <span className="hs-pill">
                              <IconClock />
                              {formatTime(p.started_at)}
                              {p.closed_at
                                ? ` to ${formatTime(p.closed_at)}`
                                : ""}
                              {duration ? `, ${duration}` : ""}
                            </span>

                            <span className="hs-pill">
                              <IconCap />
                              {allowed}
                            </span>

                            {p.deadline && (
                              <span className="hs-pill">
                                <IconBell />
                                Deadline {formatDateTime(p.deadline)}
                              </span>
                            )}
                          </span>
                        </button>

                        <div className="hs-side">
                          <div className="hs-count">
                            <strong>{attendees.length}</strong>
                            <span>
                              {attendees.length === 1 ? "student" : "students"}
                            </span>
                          </div>

                          <div className="hs-actions">
                            <button
                              type="button"
                              className="hs-icon-btn danger"
                              onClick={() => setDeleteTarget(p)}
                              disabled={!canDelete}
                              title={
                                canDelete
                                  ? "Delete session"
                                  : "End this session before deleting it"
                              }
                              aria-label={`Delete ${p.name}`}
                            >
                              <IconTrash />
                            </button>

                            <button
                              type="button"
                              className="hs-icon-btn hs-chevron"
                              onClick={() => toggle(p.id)}
                              title={isOpen ? "Hide students" : "Show students"}
                              aria-label={
                                isOpen ? "Hide students" : "Show students"
                              }
                              aria-expanded={isOpen}
                            >
                              <IconChevron />
                            </button>
                          </div>
                        </div>
                      </div>

                      {attendees.length > 0 && (
                        <div className="hs-breakdown">
                          <div className="hs-avatars">
                            {attendees.slice(0, 4).map((a, i) => (
                              <span
                                className={`hs-avatar tone-${i % 3}`}
                                key={a.id}
                                title={a.students?.full_name}
                              >
                                {getInitials(a.students?.full_name)}
                              </span>
                            ))}
                            {attendees.length > 4 && (
                              <span className="hs-avatar more">
                                +{attendees.length - 4}
                              </span>
                            )}
                          </div>

                          <div className="hs-years">
                            <div className="hs-bar">
                              {breakdown.map(([year, count], i) => (
                                <span
                                  key={year}
                                  title={`${year}: ${count}`}
                                  style={{
                                    flexGrow: count,
                                    background:
                                      BAR_SHADES[i % BAR_SHADES.length],
                                  }}
                                />
                              ))}
                            </div>

                            <div className="hs-legend">
                              {breakdown.map(([year, count], i) => (
                                <span key={year}>
                                  <i
                                    style={{
                                      background:
                                        BAR_SHADES[i % BAR_SHADES.length],
                                    }}
                                  />
                                  {year}
                                  <b>{count}</b>
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* CATEGORY BUTTONS (on every session) */}
                      <div className="hs-tabs" role="tablist">
                        {tabs.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={tab === t.id}
                            className={`hs-tab hs-tab-${t.id}${
                              tab === t.id ? " active" : ""
                            }`}
                            onClick={() => selectTab(p.id, t.id)}
                          >
                            {t.label}
                            <span className="hs-tab-count">{t.count}</span>
                          </button>
                        ))}

                        <button
                          type="button"
                          className="hs-tab-export"
                          onClick={() => exportSession(p)}
                          title="Download this session as an Excel file"
                        >
                          <IconDownload />
                          Export Excel
                        </button>
                      </div>

                      <div className="hs-panel">
                        <div className="hs-panel-inner">
                          {tab === "present" && (
                            <HistorySection
                              mode="present"
                              title="Present"
                              hint="Timed in and timed out, sorted by year level."
                              rows={p._present.map((a) => ({
                                key: a.id,
                                student: a.students,
                                time_in: a.time_in,
                                time_out: a.time_out,
                              }))}
                              emptyText="No student has completed time in and time out."
                            />
                          )}

                          {tab === "timedin" && (
                            <HistorySection
                              mode="timedin"
                              title="Timed in only"
                              hint={
                                p._sessionDone
                                  ? "Timed in but never timed out."
                                  : "Timed in and still inside. They haven't timed out yet."
                              }
                              rows={p._timedInOnly.map((a) => ({
                                key: a.id,
                                student: a.students,
                                time_in: a.time_in,
                                time_out: a.time_out,
                              }))}
                              emptyText="Everyone who timed in has also timed out."
                            />
                          )}

                          {tab === "absent" && (
                            <HistorySection
                              mode="absent"
                              title="Absent"
                              hint="Eligible students who never timed in, sorted by year level."
                              rows={p._absent.map((s) => ({
                                key: s.id || s.student_id,
                                student: s,
                              }))}
                              note={absentNoteText}
                              emptyText="No absent students. Everyone eligible timed in."
                            />
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            <div className="attendance-table-footer">
              <span>
                Showing <strong>{visible.length}</strong>{" "}
                {visible.length === 1 ? "session" : "sessions"}
              </span>
            </div>
          </section>

          <footer className="admin-footer">FON Supreme Student Council</footer>
        </div>
      </main>

      {/* DELETE CONFIRM MODAL */}
      {deleteTarget && (
        <div
          className="reset-modal-overlay"
          onClick={() => !deleting && setDeleteTarget(null)}
        >
          <div
            className="reset-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="reset-modal-icon danger">✕</div>

            <h3>Delete "{deleteTarget.name}"?</h3>

            <p>
              This permanently deletes the session and all{" "}
              {(deleteTarget.attendance || []).length} attendance record
              {(deleteTarget.attendance || []).length === 1 ? "" : "s"} linked
              to it from the database, along with that session's time in and
              time out photos in storage. This can't be undone.
            </p>

            <div className="reset-modal-actions">
              <button
                type="button"
                className="reset-modal-cancel"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>

              <button
                type="button"
                className="reset-modal-confirm danger"
                onClick={handleDeleteSession}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Yes, delete session"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminSessionHistory;