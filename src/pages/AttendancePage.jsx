import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { supabase } from "../lib/supabase";

import logoLeft from "../assets/logo-left.png";
import logoRight from "../assets/logo-right.png";
import cardPhoto from "../assets/card-photo.png";
import checkPhoto from "../assets/check.png";

// --------------------------------------------------
// FACE CHECK (runs on the student's device)
// FACE_CHECK_REQUIRED = false turns the check off completely.
// ALLOW_WITHOUT_FACE_CHECK = true lets a student still take a
// selfie when the check cannot load on their device (very old
// phone, blocked network). Those photos are saved with
// "-unchecked" in the file name. Set it to false to be strict.
// --------------------------------------------------

const FACE_CHECK_REQUIRED = true;
const ALLOW_WITHOUT_FACE_CHECK = true;

// MIRROR_SELFIE = true shows the camera like a mirror (left is left) and
// saves the photo the same way, so the selfie looks like the preview.
// Set it to false for the normal, un-flipped camera.
const MIRROR_SELFIE = true;

// Tried in order. Your own files (public/mediapipe/...) come first so
// mobile data and school Wi-Fi don't depend on other websites; the online
// copies are the backup when those files are not there.
const FACE_SOURCES = [
  {
    wasm: `${import.meta.env.BASE_URL}mediapipe/wasm`,
    model: `${import.meta.env.BASE_URL}mediapipe/face_landmarker.task`,
  },
  {
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    model:
      "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  },
];

// Loaded once, then reused every time the camera opens
let faceLandmarkerPromise = null;

function loadFaceLandmarker() {
  if (!faceLandmarkerPromise) {
    async function createFromSource(source) {
      const vision = await FilesetResolver.forVisionTasks(source.wasm);

      const buildOptions = (delegate) => ({
        baseOptions: { modelAssetPath: source.model, delegate },
        runningMode: "VIDEO",
        numFaces: 2,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
      });

      try {
        return await FaceLandmarker.createFromOptions(
          vision,
          buildOptions("GPU")
        );
      } catch {
        return await FaceLandmarker.createFromOptions(
          vision,
          buildOptions("CPU")
        );
      }
    }

    faceLandmarkerPromise = (async () => {
      let lastError;

      for (const source of FACE_SOURCES) {
        try {
          return await createFromSource(source);
        } catch (error) {
          console.warn("Face check source failed:", source.model, error);
          lastError = error;
        }
      }

      throw lastError;
    })().catch((error) => {
      faceLandmarkerPromise = null;
      throw error;
    });
  }

  return faceLandmarkerPromise;
}

// Eye corners, nose tip, mouth corners and lips
const FACE_FEATURE_POINTS = [33, 133, 263, 362, 1, 61, 291, 13, 14];

// Returns { ok, text } for the current video frame
function checkFace(landmarker, video) {
  if (!video || video.readyState < 2 || !video.videoWidth) {
    return { ok: false, text: "Starting camera..." };
  }

  const result = landmarker.detectForVideo(video, performance.now());
  const faces = result?.faceLandmarks || [];

  if (faces.length === 0) {
    return { ok: false, text: "No face detected. Face the camera." };
  }

  if (faces.length > 1) {
    return { ok: false, text: "Only one face is allowed in the photo." };
  }

  const points = faces[0];

  // Eyes, nose and mouth must all be visible inside the frame
  const featuresVisible = FACE_FEATURE_POINTS.every((index) => {
    const point = points[index];

    return (
      point && point.x > 0.02 && point.x < 0.98 && point.y > 0.02 && point.y < 0.98
    );
  });

  if (!featuresVisible) {
    return { ok: false, text: "Keep your whole face inside the frame." };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const faceHeight = maxY - minY;

  if (faceHeight < 0.3) {
    return { ok: false, text: "Move a little closer to the camera." };
  }

  if (faceHeight > 0.95) {
    return { ok: false, text: "Move a little farther from the camera." };
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  if (centerX < 0.3 || centerX > 0.7 || centerY < 0.25 || centerY > 0.75) {
    return { ok: false, text: "Center your face in the frame." };
  }

  // Nose position between the left and right cheek = facing the camera
  const leftCheek = points[234];
  const rightCheek = points[454];
  const nose = points[1];

  const turn = (nose.x - leftCheek.x) / (rightCheek.x - leftCheek.x);

  if (turn < 0.3 || turn > 0.7) {
    return { ok: false, text: "Look straight at the camera." };
  }

  return { ok: true, text: "Face detected. Hold still and capture." };
}

// --------------------------------------------------
// CONNECTION HELPERS
// Weak signal, mobile data and slow Wi-Fi: every request
// has a time limit and is retried before showing an error.
// --------------------------------------------------

const NETWORK_MESSAGE =
  "Weak or no internet connection. Check your signal, or switch between Wi-Fi and mobile data, then try again.";

const NETWORK_RECORD_MESSAGE =
  "Your connection is weak, so we couldn't confirm your attendance. Check your signal, then tap Confirm again.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkError(error) {
  const text = `${error?.name || ""} ${error?.message || ""}`.toLowerCase();

  return (
    text.includes("failed to fetch") ||
    text.includes("load failed") ||
    text.includes("networkerror") ||
    text.includes("network request failed") ||
    text.includes("network") ||
    text.includes("timed out") ||
    text.includes("fetch") ||
    text.includes("abort") ||
    text.includes("offline")
  );
}

function friendlyError(error, fallback) {
  if (isNetworkError(error)) return NETWORK_MESSAGE;

  return error?.message || fallback;
}

function timeoutAfter(ms) {
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ data: null, error: { message: "Request timed out" } }),
      ms
    )
  );
}

// run() must return a Supabase-style { data, error } result
async function withRetry(run, { tries = 3, timeout = 15000 } = {}) {
  let last = { data: null, error: { message: "Request failed" } };

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const result = await Promise.race([run(), timeoutAfter(timeout)]);

      if (!result?.error || !isNetworkError(result.error)) return result;

      last = result;
    } catch (error) {
      if (!isNetworkError(error)) throw error;

      last = { data: null, error };
    }

    if (attempt < tries) await sleep(700 * attempt);
  }

  return last;
}

// Facebook, Messenger, Instagram, TikTok, Line... in-app browsers
// often block the camera. Safari / Chrome work properly.
function isInAppBrowser() {
  if (typeof navigator === "undefined") return false;

  return /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|Line\/|TikTok|musical_ly|Snapchat|MicroMessenger/i.test(
    navigator.userAgent
  );
}

// --------------------------------------------------
// PRIVACY NOTICE (shown once per device)
// Bump the version to ask everyone to accept again.
// --------------------------------------------------

const CONSENT_KEY = "fon_attendance_privacy_consent_v1";

function hasStoredConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) !== null;
  } catch {
    return false;
  }
}

const noticeStyles = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "rgba(40, 30, 20, 0.55)",
    backdropFilter: "blur(4px)",
  },
  card: {
    width: "100%",
    maxWidth: 540,
    maxHeight: "92vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    textAlign: "left",
    background: "#ffffff",
    borderRadius: 18,
    boxShadow: "0 30px 60px -20px rgba(40, 30, 20, 0.45)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "22px 24px 14px",
    borderBottom: "1px solid #f3e4d8",
  },
  lock: {
    flex: "none",
    width: 46,
    height: 46,
    display: "grid",
    placeItems: "center",
    borderRadius: 14,
    background: "#ffe3d1",
    fontSize: 22,
  },
  title: { margin: 0, fontSize: 19, color: "#171a19" },
  subtitle: { margin: "2px 0 0", fontSize: 12.5, color: "#7a817d" },
  body: {
    overflowY: "auto",
    padding: "16px 24px",
    fontSize: 13.5,
    lineHeight: 1.6,
    color: "#515956",
  },
  heading: { margin: "14px 0 4px", fontSize: 13.5, color: "#171a19" },
  paragraph: { margin: 0 },
  list: { margin: "4px 0 0", paddingLeft: 20 },
  footer: {
    padding: "16px 24px 20px",
    borderTop: "1px solid #f3e4d8",
    background: "#fdf8f4",
  },
  check: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    margin: "0 0 14px",
    fontSize: 13,
    lineHeight: 1.5,
    color: "#303734",
    cursor: "pointer",
  },
  checkbox: {
    flex: "none",
    width: 18,
    height: 18,
    marginTop: 2,
    accentColor: "#e8793b",
    cursor: "pointer",
  },
};

function PrivacyNotice({ consentGiven, agreed, onAgreeChange, onAccept, onClose }) {
  return createPortal(
    <div style={noticeStyles.overlay} role="dialog" aria-modal="true">
      <div style={noticeStyles.card}>
        <div style={noticeStyles.header}>
          <div style={noticeStyles.lock}>🔒</div>

          <div>
            <h2 style={noticeStyles.title}>Data Privacy Notice</h2>
            <p style={noticeStyles.subtitle}>
              FON Supreme Student Council Attendance System
            </p>
          </div>
        </div>

        <div style={noticeStyles.body}>
          <p style={noticeStyles.paragraph}>
            The FON Supreme Student Council (FON SSC) values your privacy. This
            notice explains how your information is handled in this system, in
            line with the Data Privacy Act of 2012 (Republic Act No. 10173).
          </p>

          <h4 style={noticeStyles.heading}>What we collect</h4>
          <ul style={noticeStyles.list}>
            <li>Your username, full name, year level and section</li>
            <li>The date and time you time in and time out</li>
            <li>A selfie taken at time in and time out to verify your attendance</li>
          </ul>

          <h4 style={noticeStyles.heading}>Why we collect it</h4>
          <p style={noticeStyles.paragraph}>
            Only to record and verify attendance in FON SSC activities and
            programs. It is not used for any other purpose.
          </p>

          <h4 style={noticeStyles.heading}>Your information is confidential</h4>
          <p style={noticeStyles.paragraph}>
            Your information and photos are not sold, shared or disclosed to
            outside parties, and they are never posted publicly. They can be
            viewed only by authorized FON SSC officers who manage attendance,
            through a password-protected admin account.
          </p>

          <h4 style={noticeStyles.heading}>How we protect it</h4>
          <p style={noticeStyles.paragraph}>
            Your data is stored in a protected online database with restricted
            access and is sent through encrypted (HTTPS) connections. Records
            and photos are kept only as long as needed for attendance purposes.
          </p>

          <h4 style={noticeStyles.heading}>Camera and device storage</h4>
          <p style={noticeStyles.paragraph}>
            The camera is used only when you tap “Take Selfie”. Your selfie is
            checked on your own device to confirm that a face is visible; no
            face data is stored. When you accept this notice, a small note is
            saved in your browser so you are not asked again on this device.
            This system does not use cookies for advertising or tracking.
          </p>

          <h4 style={noticeStyles.heading}>Your rights</h4>
          <p style={noticeStyles.paragraph}>
            You may ask an FON SSC officer to access, correct or delete your
            information at any time.
          </p>

          <h4 style={noticeStyles.heading}>Stay safe</h4>
          <p style={noticeStyles.paragraph}>
            Your username is your key to this system. Do not share it with
            anyone, and only time in or time out for yourself.
          </p>
        </div>

        <div style={noticeStyles.footer}>
          {consentGiven ? (
            <button className="secondary-button" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <label style={noticeStyles.check}>
                <input
                  type="checkbox"
                  style={noticeStyles.checkbox}
                  checked={agreed}
                  onChange={(event) => onAgreeChange(event.target.checked)}
                />

                <span>
                  I have read and understood this notice, and I agree to the
                  collection and use of my information and selfie for
                  attendance purposes.
                </span>
              </label>

              <button
                className="primary-button"
                onClick={onAccept}
                disabled={!agreed}
              >
                Continue
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

const blockedStyles = {
  icon: {
    width: 56,
    height: 56,
    margin: "0 auto 12px",
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    background: "#ffe3d1",
    color: "#e8793b",
    fontSize: 30,
    fontWeight: 800,
  },
  box: {
    margin: "16px 0 20px",
    padding: "14px 16px",
    display: "grid",
    gap: 4,
    textAlign: "left",
    background: "#fdf1e8",
    border: "1px solid #f6d9c4",
    borderRadius: 12,
    color: "#8a4b26",
    fontSize: 14,
    lineHeight: 1.5,
  },
};

// --------------------------------------------------
// ANIMATED CAMERA (replaces the 📷 emoji)
// The lens aperture closes and reopens like a shutter,
// then the flash bursts. One 3s loop, all parts in sync.
// --------------------------------------------------

const cameraAnimCss = `
.cam-svg { width: 72px; height: 60px; overflow: visible; }
.cam-body { transform-box: fill-box; transform-origin: center; animation: cam-click 3s ease-in-out infinite; }
.cam-aperture { transform-box: fill-box; transform-origin: center; animation: cam-lens 3s ease-in-out infinite; }
.cam-glint { animation: cam-glint 3s ease-in-out infinite; }
.cam-bulb { animation: cam-bulb 3s ease-in-out infinite; }
.cam-burst { transform-box: fill-box; transform-origin: center; opacity: 0; animation: cam-burst 3s ease-out infinite; }
.cam-rays { transform-box: fill-box; transform-origin: center; opacity: 0; animation: cam-rays 3s ease-out infinite; }

@keyframes cam-lens {
  0%, 52%  { transform: scale(1); }
  60%      { transform: scale(0.15); }
  66%      { transform: scale(1.2); }
  76%, 100%{ transform: scale(1); }
}
@keyframes cam-click {
  0%, 56%, 70%, 100% { transform: scale(1); }
  62%                { transform: scale(0.96); }
}
@keyframes cam-glint {
  0%, 55%, 100% { opacity: 0.85; }
  62%           { opacity: 0; }
}
@keyframes cam-bulb {
  0%, 58%, 100% { fill: #fff3c4; }
  64%           { fill: #ffffff; }
}
@keyframes cam-burst {
  0%, 60% { opacity: 0; transform: scale(0.3); }
  64%     { opacity: 0.95; transform: scale(1); }
  82%     { opacity: 0; transform: scale(5); }
  100%    { opacity: 0; transform: scale(5); }
}
@keyframes cam-rays {
  0%, 60% { opacity: 0; transform: scale(0.5) rotate(0deg); }
  64%     { opacity: 1; transform: scale(1) rotate(10deg); }
  80%, 100% { opacity: 0; transform: scale(1.6) rotate(25deg); }
}
@media (prefers-reduced-motion: reduce) {
  .cam-body, .cam-aperture, .cam-glint, .cam-bulb, .cam-burst, .cam-rays { animation: none; }
}
`;

function AnimatedCamera() {
  return (
    <>
      <style>{cameraAnimCss}</style>

      <svg className="cam-svg" viewBox="0 0 120 100" aria-hidden="true">
        <g className="cam-body">
          {/* top bump + flash housing */}
          <rect x="38" y="8" width="30" height="18" rx="5" fill="#d9672a" />
          <rect x="84" y="12" width="18" height="12" rx="3" fill="#d9672a" />
          <rect className="cam-bulb" x="87" y="14" width="12" height="8" rx="2" fill="#fff3c4" />

          {/* body */}
          <rect x="8" y="22" width="104" height="70" rx="15" fill="#e8793b" />
          <rect x="8" y="32" width="104" height="6" fill="#d9672a" opacity="0.5" />

          {/* lens */}
          <circle cx="60" cy="58" r="27" fill="#4a3a35" />
          <circle cx="60" cy="58" r="21" fill="#2b2321" stroke="#ffd9c2" strokeWidth="2.5" />
          <circle className="cam-aperture" cx="60" cy="58" r="13" fill="#7fb4ff" />
          <circle cx="60" cy="58" r="6" fill="#1d3b73" opacity="0.55" />
          <circle className="cam-glint" cx="54" cy="52" r="3.5" fill="#fff" />

          {/* shutter button */}
          <circle cx="24" cy="32" r="3.5" fill="#ffa3c4" />
        </g>

        {/* flash effects (sit on top of the body, centred on the bulb) */}
        <circle className="cam-burst" cx="93" cy="18" r="8" fill="#fff6d6" />
        <g className="cam-rays" stroke="#ffd45e" strokeWidth="2.5" strokeLinecap="round">
          <line x1="93" y1="2" x2="93" y2="-4" />
          <line x1="106" y1="6" x2="111" y2="1" />
          <line x1="112" y1="18" x2="118" y2="18" />
          <line x1="80" y1="6" x2="75" y2="1" />
        </g>
      </svg>
    </>
  );
}

// "Salleh, John Kenneth" -> "John"
function getFirstName(fullName) {
  const given = (fullName || "").split(",")[1] || "";

  return given.trim().split(/\s+/)[0] || "student";
}

function AttendancePage() {
  const [studentId, setStudentId] = useState("");
  const [student, setStudent] = useState(null);
  const [todayAttendance, setTodayAttendance] = useState(null);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");

  // Camera
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);

  // Face check
  const faceLandmarkerRef = useRef(null);
  const [faceStatus, setFaceStatus] = useState({
    state: "loading",
    text: "Loading face check...",
  });

  // Connection
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [programError, setProgramError] = useState(false);
  const [inAppBrowser] = useState(isInAppBrowser);
  const [linkCopied, setLinkCopied] = useState(false);

  // Captured selfie (before confirming)
  const [photo, setPhoto] = useState(null);

  // "time_in" or "time_out"
  const [cameraMode, setCameraMode] = useState(null);

  // NEW: confirmed selfie kept so the student can save a copy to their device
  const [savedPhoto, setSavedPhoto] = useState(null);

  // NEW: open attendance session. undefined = checking, null = not open
  const [program, setProgram] = useState(undefined);

  // NEW: student found, but their year level is not in this session
  const [notAllowed, setNotAllowed] = useState(null);

  // NEW: privacy notice, remembered per device
  const [consentGiven, setConsentGiven] = useState(hasStoredConsent);
  const [showNotice, setShowNotice] = useState(false);
  const [agreed, setAgreed] = useState(false);

  const noticeOpen = !consentGiven || showNotice;

  function acceptNotice() {
    try {
      localStorage.setItem(
        CONSENT_KEY,
        JSON.stringify({ accepted: true, at: new Date().toISOString() })
      );
    } catch {
      // Storage blocked (e.g. private mode): the notice will show next visit
    }

    setConsentGiven(true);
    setShowNotice(false);
  }

  // Lock page scrolling while the notice is open
  useEffect(() => {
    document.body.style.overflow = noticeOpen ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [noticeOpen]);

  // --------------------------------------------------
  // ONLINE / OFFLINE
  // --------------------------------------------------

  useEffect(() => {
    function goOnline() {
      setOnline(true);
      loadProgram();
    }

    function goOffline() {
      setOnline(false);
    }

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  async function copyPageLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
    } catch {
      window.prompt("Copy this link and open it in Safari or Chrome:", window.location.href);
    }
  }

  // --------------------------------------------------
  // MESSAGE
  // --------------------------------------------------

  function showMessage(text, type = "info") {
    setMessage(text);
    setMessageType(type);
  }

  // --------------------------------------------------
  // FIND STUDENT
  // --------------------------------------------------

  async function findStudent() {
    // Usernames are stored in capitals; phones often type lowercase
    const id = studentId.replace(/\s+/g, "").toUpperCase();

    if (!id) {
      showMessage("Please enter your Attendance username.", "error");
      return;
    }

    setLoading(true);
    setNotAllowed(null);
    setStudent(null);
    setTodayAttendance(null);
    setMessage("");
    setMessageType("");

    try {
      const { data: studentData, error: studentError } = await withRetry(() =>
        supabase.rpc("find_student", { p_student_id: id })
      );

      if (studentError) throw studentError;

      // Year level not included in this session
      if (studentData?.allowed === false) {
        setNotAllowed(studentData);
        return;
      }

      setStudent(studentData);

      const { data: attendanceData, error: attendanceError } =
        await withRetry(() =>
          supabase.rpc("get_today_attendance", { p_student_id: id })
        );

      if (attendanceError) throw attendanceError;

      setTodayAttendance(attendanceData);
    } catch (error) {
      console.error("Find student error:", error);
      showMessage(friendlyError(error, "Unable to find student."), "error");
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // CLEAR STUDENT
  // --------------------------------------------------

  function clearStudent() {
    stopCamera();

    if (photo?.url) URL.revokeObjectURL(photo.url);
    if (savedPhoto?.url) URL.revokeObjectURL(savedPhoto.url);

    setStudentId("");
    setNotAllowed(null);
    setStudent(null);
    setTodayAttendance(null);

    setMessage("");
    setMessageType("");

    setPhoto(null);
    setSavedPhoto(null);
    setCameraOpen(false);
    setCameraLoading(false);
    setCameraMode(null);
  }

  // --------------------------------------------------
  // CAMERA
  // --------------------------------------------------

  async function openCamera(mode = "time_in") {
    if (!navigator.mediaDevices?.getUserMedia) {
      showMessage(
        inAppBrowser
          ? "This in-app browser blocks the camera. Open this page in Safari or Chrome."
          : "Your browser does not support camera access.",
        "error"
      );
      return;
    }

    setCameraMode(mode);
    setCameraLoading(true);
    setMessage("");
    setMessageType("");

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = mediaStream;
      setCameraOpen(true);

      // Attach stream after the video element appears
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          videoRef.current.play().catch(() => {});
        }
      }, 100);
    } catch (error) {
      console.error("Camera error:", error);

      if (error.name === "NotAllowedError") {
        showMessage(
          "Camera permission was denied. Please allow camera access and try again.",
          "error"
        );
      } else if (error.name === "NotFoundError") {
        showMessage("No camera was found on this device.", "error");
      } else if (error.name === "NotReadableError") {
        showMessage(
          "The camera is already being used by another application.",
          "error"
        );
      } else {
        showMessage("Unable to open the camera.", "error");
      }
    } finally {
      setCameraLoading(false);
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraOpen(false);
  }

  // --------------------------------------------------
  // FACE CHECK: START LOADING EARLY
  // The model starts downloading as soon as the student is found,
  // so it is usually ready by the time the camera opens.
  // --------------------------------------------------

  useEffect(() => {
    if (student && FACE_CHECK_REQUIRED) {
      loadFaceLandmarker().catch(() => {});
    }
  }, [student]);

  // --------------------------------------------------
  // FACE CHECK LOOP
  // Runs while the camera is open and updates the status
  // shown under the preview. Capture stays disabled until
  // a single, centered, front-facing face is detected.
  // --------------------------------------------------

  useEffect(() => {
    if (!cameraOpen || !FACE_CHECK_REQUIRED) return;

    let cancelled = false;
    let timer = null;

    function updateStatus(next) {
      setFaceStatus((previous) =>
        previous.state === next.state && previous.text === next.text
          ? previous
          : next
      );
    }

    updateStatus({
      state: "loading",
      text: "Loading face check... this can take a moment on mobile data.",
    });

    // Slow network: after 45 seconds, let the student continue
    const slowTimer = setTimeout(() => {
      if (!cancelled && !faceLandmarkerRef.current && ALLOW_WITHOUT_FACE_CHECK) {
        updateStatus({
          state: "unavailable",
          text: "Face check is taking too long. You can still take your selfie.",
        });
      }
    }, 45000);

    loadFaceLandmarker()
      .then((landmarker) => {
        if (cancelled) return;

        faceLandmarkerRef.current = landmarker;

        function tick() {
          try {
            const result = checkFace(landmarker, videoRef.current);

            updateStatus({
              state: result.ok ? "ok" : "warn",
              text: result.text,
            });
          } catch (error) {
            console.error("Face check error:", error);
          }
        }

        tick();
        timer = setInterval(tick, 300);
      })
      .catch((error) => {
        console.error("Face check failed to load:", error);

        if (cancelled) return;

        updateStatus(
          ALLOW_WITHOUT_FACE_CHECK
            ? {
                state: "unavailable",
                text: "Face check isn't available on this device. You can still take your selfie.",
              }
            : {
                state: "error",
                text: "Face check could not load. Check your connection, then cancel and reopen the camera.",
              }
        );
      });

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      if (timer) clearInterval(timer);
    };
  }, [cameraOpen]);

  // --------------------------------------------------
  // CAPTURE PHOTO
  // --------------------------------------------------

  function capturePhoto() {
    const video = videoRef.current;

    if (!video) {
      showMessage("Camera is not ready yet.", "error");
      return;
    }

    if (!video.videoWidth || !video.videoHeight) {
      showMessage("Please wait for the camera preview to load.", "error");
      return;
    }

    // Final face check on the exact frame being captured
    let unchecked = false;

    if (FACE_CHECK_REQUIRED) {
      const landmarker = faceLandmarkerRef.current;

      if (!landmarker) {
        if (ALLOW_WITHOUT_FACE_CHECK && faceStatus.state === "unavailable") {
          unchecked = true;
        } else {
          showMessage("Face check is still loading. Please wait.", "error");
          return;
        }
      } else {
        let faceResult;

        try {
          faceResult = checkFace(landmarker, video);
        } catch (error) {
          console.error("Face check error:", error);
          faceResult = {
            ok: false,
            text: "Face check failed. Please try again.",
          };
        }

        if (!faceResult.ok) {
          showMessage(faceResult.text, "error");
          return;
        }
      }
    }

    const canvas = document.createElement("canvas");

    // Compress image to a reasonable size
    const maxWidth = 720;
    const scale = Math.min(1, maxWidth / video.videoWidth);

    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const context = canvas.getContext("2d");

    if (!context) {
      showMessage("Unable to process the selfie.", "error");
      return;
    }

    if (MIRROR_SELFIE) {
      // Flip horizontally so the saved selfie matches the mirrored preview
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          showMessage("Unable to capture the photo.", "error");
          return;
        }

        const photoUrl = URL.createObjectURL(blob);

        if (photo?.url) URL.revokeObjectURL(photo.url);

        setPhoto({ blob, url: photoUrl, unchecked });
        setMessage("");
        setMessageType("");
        stopCamera();
      },
      "image/jpeg",
      0.75
    );
  }

  // --------------------------------------------------
  // RETAKE
  // --------------------------------------------------

  function retakePhoto() {
    if (photo?.url) URL.revokeObjectURL(photo.url);

    setPhoto(null);
    setMessage("");
    setMessageType("");

    openCamera(cameraMode || "time_in");
  }

  // --------------------------------------------------
  // CONFIRM + UPLOAD + RECORD TIME IN / TIME OUT
  // --------------------------------------------------

  async function confirmPhoto() {
    if (!photo?.blob) {
      showMessage("Please capture a selfie first.", "error");
      return;
    }

    if (!student?.student_id) {
      showMessage("Student information is missing.", "error");
      return;
    }

    setLoading(true);
    setMessage("");
    setMessageType("");

    let uploadedPhotoPath = null;

    try {
      // Philippine date, used only to organize the Storage path
      const manilaDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());

      const uniqueId = crypto.randomUUID();
      const photoType = cameraMode === "time_out" ? "time-out" : "time-in";
      const fileTag = photo.unchecked ? `${photoType}-unchecked` : photoType;

      uploadedPhotoPath = `${student.student_id}/${manilaDate}/${fileTag}-${uniqueId}.jpg`;

      // Upload selfie (retried on weak connections)
      const { error: uploadError } = await withRetry(
        () =>
          supabase.storage
            .from("attendance-photos")
            .upload(uploadedPhotoPath, photo.blob, {
              contentType: "image/jpeg",
              cacheControl: "3600",
              upsert: false,
            }),
        { tries: 3, timeout: 45000 }
      );

      // "Already exists" means an earlier try got through: that's fine
      if (
        uploadError &&
        !/already exists|duplicate/i.test(uploadError.message || "")
      ) {
        throw uploadError;
      }

      // Record attendance
      const rpcName =
        cameraMode === "time_out" ? "record_time_out" : "record_time_in";

      const { data: attendanceData, error: attendanceError } =
        await withRetry(
          () =>
            supabase.rpc(rpcName, {
              p_student_id: student.student_id,
              p_photo_path: uploadedPhotoPath,
            }),
          { tries: 1, timeout: 30000 }
        );

      if (attendanceError) throw attendanceError;

      console.log(`${rpcName} response:`, attendanceData);

      // Refresh attendance
      const { data: updatedAttendance, error: refreshError } =
        await withRetry(
          () =>
            supabase.rpc("get_today_attendance", {
              p_student_id: student.student_id,
            }),
          { tries: 2, timeout: 15000 }
        );

      if (refreshError) {
        console.error("Attendance refresh error:", refreshError);
      } else {
        setTodayAttendance(updatedAttendance);
      }

      // NEW: keep the confirmed selfie so the student can save a copy.
      // The preview URL is reused, so it is NOT revoked here.
      if (savedPhoto?.url) URL.revokeObjectURL(savedPhoto.url);

      setSavedPhoto({
        blob: photo.blob,
        url: photo.url,
        filename: `attendance_${getLastName(student.full_name)}_${manilaDate}_${photoType}.jpg`,
      });

      setPhoto(null);
      setCameraMode(null);

      showMessage(
        cameraMode === "time_out"
          ? "Time Out recorded successfully!"
          : "Time In recorded successfully!",
        "success"
      );
    } catch (error) {
      console.error("Attendance recording error:", error);

      const networkProblem = isNetworkError(error);

      // Remove the orphaned selfie if the database rejected the record.
      // Skipped on connection errors: the record may have gone through,
      // and deleting its photo would break it.
      if (uploadedPhotoPath && !networkProblem) {
        const { error: cleanupError } = await supabase.storage
          .from("attendance-photos")
          .remove([uploadedPhotoPath]);

        if (cleanupError) {
          console.error("Photo cleanup error:", cleanupError);
        }
      }

      showMessage(
        networkProblem
          ? NETWORK_RECORD_MESSAGE
          : error.message ||
              (cameraMode === "time_out"
                ? "Unable to record Time Out."
                : "Unable to record Time In."),
        "error"
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // NEW: SAVE PHOTO TO GALLERY
  // iPhone/iPad: share sheet ("Save Image" -> Photos)
  // Android/desktop: normal download
  // --------------------------------------------------

  async function savePhotoToGallery() {
    if (!savedPhoto) return;

    const file = new File([savedPhoto.blob], savedPhoto.filename, {
      type: "image/jpeg",
    });

    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    if (isIOS && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Attendance photo" });
        return;
      } catch (error) {
        // Student closed the share sheet: do nothing
        if (error.name === "AbortError") return;
        // Any other error: fall through to download
      }
    }

    const link = document.createElement("a");
    link.href = savedPhoto.url;
    link.download = savedPhoto.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    showMessage("Photo saved to your device.", "success");
  }

  // --------------------------------------------------
  // CLEAN UP CAMERA WHEN PAGE UNMOUNTS
  // --------------------------------------------------

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (photo?.url) URL.revokeObjectURL(photo.url);
    };
  }, []);

  // --------------------------------------------------
  // NEW: CHECK IF THE ADMIN HAS OPENED A SESSION
  // Re-checks every 20 seconds so the page opens/closes by itself.
  // A connection failure is NOT shown as "session not open".
  // --------------------------------------------------

  async function loadProgram() {
    const { data, error } = await withRetry(
      () => supabase.rpc("get_open_program"),
      { tries: 2, timeout: 12000 }
    );

    if (error) {
      console.error("Session check error:", error);

      if (isNetworkError(error)) {
        setProgramError(true);
        return;
      }

      setProgram((previous) => (previous === undefined ? null : previous));
      return;
    }

    setProgramError(false);
    setProgram(data?.open ? data : null);
  }

  useEffect(() => {
    loadProgram();

    const timer = setInterval(loadProgram, 20000);

    return () => clearInterval(timer);
  }, []);

  // --------------------------------------------------
  // CAMERA PANEL (live preview + face status + buttons)
  // Used by both Time In and Time Out
  // --------------------------------------------------

  function renderCameraPanel(captureLabel) {
    const faceReady =
      !FACE_CHECK_REQUIRED ||
      faceStatus.state === "ok" ||
      (ALLOW_WITHOUT_FACE_CHECK && faceStatus.state === "unavailable");

    return (
      <div className="camera-container">
        <div className={`camera-frame ${FACE_CHECK_REQUIRED ? faceStatus.state : ""}`}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="camera-preview"
            style={MIRROR_SELFIE ? { transform: "scaleX(-1)" } : undefined}
          />

          {FACE_CHECK_REQUIRED && (
            <div className="face-guide" aria-hidden="true" />
          )}
        </div>

        {FACE_CHECK_REQUIRED && (
          <div className={`face-status ${faceStatus.state}`} role="status">
            {faceStatus.text}
          </div>
        )}

        <div className="camera-controls">
          <button
            className="primary-button capture-button"
            onClick={capturePhoto}
            disabled={loading || !faceReady}
          >
            {captureLabel}
          </button>

          <button
            className="secondary-button"
            onClick={() => {
              stopCamera();
              setCameraMode(null);
            }}
            disabled={loading}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // PAGE
  // --------------------------------------------------

  return (
    <div className="attendance-page">
      {noticeOpen && (
        <PrivacyNotice
          consentGiven={consentGiven}
          agreed={agreed}
          onAgreeChange={setAgreed}
          onAccept={acceptNotice}
          onClose={() => setShowNotice(false)}
        />
      )}

      <header className="attendance-header">
        <div className="school-logo">✔</div>
        <div>
          <h1>FON Attendance System</h1>
          <p>Digital Attendance Tracking</p>
        </div>
      </header>

      <main className="attendance-container">
        {!online && (
          <div className="notice-banner offline" role="alert">
            You're offline. Reconnect to Wi-Fi or mobile data to continue.
          </div>
        )}

        {inAppBrowser && (
          <div className="notice-banner">
            For the camera to work, open this page in Safari or Chrome.{" "}
            <button type="button" className="link-button" onClick={copyPageLink}>
              {linkCopied ? "Link copied" : "Copy link"}
            </button>
          </div>
        )}

        <div className="dual-logos">
          <img src={logoLeft} alt="Left logo" />
          <img src={logoRight} alt="Right logo" />
        </div>

        {/* CHECKING SESSION */}
        {!student && program === undefined && !programError && (
          <section className="attendance-card">
            <h2>Checking attendance session...</h2>
          </section>
        )}

        {/* CANNOT REACH THE SERVER */}
        {!student && program === undefined && programError && (
          <section className="attendance-card">
            <div className="card-icon">
              <img src={cardPhoto} alt="Attendance" />
            </div>

            <h2>Can't Connect</h2>

            <p className="instruction">
              We couldn't reach the attendance server. Check your signal, or
              switch between Wi-Fi and mobile data.
            </p>

            <button className="primary-button" onClick={loadProgram}>
              Try again
            </button>
          </section>
        )}

        {/* NO SESSION OPEN */}
        {!student && program === null && (
          <section className="attendance-card">
            <div className="card-icon">
              <img src={cardPhoto} alt="Attendance" />
            </div>

            <h2>Attendance Session Not Open</h2>

            <p className="instruction">
              The attendance session has not been opened yet. Please wait for
              the admin to start it.
            </p>
          </section>
        )}

        {/* YEAR LEVEL NOT INCLUDED */}
        {!student && program && notAllowed && (
          <section className="attendance-card">
            <div style={blockedStyles.icon}>!</div>

            <h2>Oops, sorry {getFirstName(notAllowed.full_name)}!</h2>

            <p className="instruction">
              Your year level is not included in this session.
            </p>

            <div style={blockedStyles.box}>
              <div>
                <strong>Session:</strong> {program.name}
              </div>

              <div>
                <strong>Open to:</strong>{" "}
                {program.allowed_year_levels?.length > 0
                  ? program.allowed_year_levels.join(", ")
                  : "All year levels"}
              </div>

              <div>
                <strong>Your year level:</strong> {notAllowed.year_level}
              </div>
            </div>

            <button className="secondary-button" onClick={clearStudent}>
              Try another username
            </button>
          </section>
        )}

        {/* STUDENT ID */}
        {!student && program && !notAllowed && (
          <section className="attendance-card">
            <div className="card-icon">
              <img src={cardPhoto} alt="Attendance" />
            </div>

            <h2>Welcome FON Students</h2>

            <p className="instruction">
              <strong>{program.name}</strong>
              {program.allowed_year_levels?.length > 0 &&
                ` — open to ${program.allowed_year_levels.join(", ")} only`}
            </p>

            <p className="instruction">Enter your username to continue.</p>

            <label htmlFor="studentId">Username:</label>

            <input
              id="studentId"
              type="text"
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") findStudent();
              }}
              placeholder="Example: ABCD1234"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />

            <button
              className="primary-button"
              onClick={findStudent}
              disabled={loading}
            >
              {loading ? "Searching..." : "Continue"}
            </button>

            {message && (
              <div className={`message ${messageType}`}>{message}</div>
            )}
          </section>
        )}

        {/* STUDENT FOUND */}
        {student && (
          <section className="attendance-card">
            <div className="success-icon">
              <img src={checkPhoto} alt="Success" />
            </div>

            <h2>Student Found</h2>

            <div className="student-information">
              <div className="student-row">
                <span>Username</span>
                <strong>{student.student_id}</strong>
              </div>

              <div className="student-row">
                <span>Full Name</span>
                <strong>{student.full_name}</strong>
              </div>

              <div className="student-row">
                <span>Year</span>
                <strong>{student.year_level}</strong>
              </div>

              <div className="student-row">
                <span>Section</span>
                <strong>{student.section}</strong>
              </div>
            </div>

            {/* TIME IN */}
            {todayAttendance?.has_attendance === false && (
              <div className="attendance-action">
                <h3>Time In</h3>

                <p>Take a selfie to verify your attendance.</p>

                {!cameraOpen && !photo && (
                  <>
                    <div className="camera-placeholder">
                      <AnimatedCamera />
                    </div>

                    <button
                      className="primary-button"
                      onClick={() => openCamera("time_in")}
                      disabled={cameraLoading || loading}
                    >
                      {cameraLoading ? "Opening Camera..." : "Take Selfie"}
                    </button>
                  </>
                )}

                {cameraOpen && renderCameraPanel("Capture")}

                {photo && (
                  <div className="photo-preview-container">
                    <img
                      src={photo.url}
                      alt={
                        cameraMode === "time_out"
                          ? "Time Out selfie preview"
                          : "Time In selfie preview"
                      }
                      className="photo-preview"
                    />

                    <p>Is this selfie clear and recognizable?</p>

                    <div className="camera-controls">
                      <button
                        className="secondary-button"
                        onClick={retakePhoto}
                        disabled={loading}
                      >
                        Retake
                      </button>

                      <button
                        className="primary-button"
                        onClick={confirmPhoto}
                        disabled={loading}
                      >
                        {loading ? "Recording..." : "Confirm"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ALREADY TIMED IN -> TIME OUT */}
            {todayAttendance?.has_attendance && !todayAttendance.time_out && (
              <div className="attendance-action">
                <div className="time-display">
                  <img src={checkPhoto} alt="Timed in" />
                </div>

                <h3>You're already timed in</h3>

                <p>
                  Time In: <strong>{formatTime(todayAttendance.time_in)}</strong>
                </p>

                {!cameraOpen && !photo && (
                  <>
                    <div className="camera-placeholder">
                      <AnimatedCamera />
                    </div>

                    <p>Take a selfie to verify your Time Out.</p>

                    <button
                      className="primary-button"
                      onClick={() => openCamera("time_out")}
                      disabled={cameraLoading || loading}
                    >
                      {cameraLoading
                        ? "Opening Camera..."
                        : "Take Selfie & Time Out"}
                    </button>
                  </>
                )}

                {cameraOpen &&
                  cameraMode === "time_out" &&
                  renderCameraPanel("Capture Time Out Selfie")}

                {photo && cameraMode === "time_out" && (
                  <div className="photo-preview-container">
                    <img
                      src={photo.url}
                      alt="Time Out selfie preview"
                      className="photo-preview"
                    />

                    <p>Confirm this selfie for your Time Out?</p>

                    <div className="camera-controls">
                      <button
                        className="secondary-button"
                        onClick={retakePhoto}
                        disabled={loading}
                      >
                        Retake
                      </button>

                      <button
                        className="primary-button"
                        onClick={confirmPhoto}
                        disabled={loading}
                      >
                        {loading ? "Recording..." : "Confirm Time Out"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ATTENDANCE COMPLETE */}
            {todayAttendance?.has_attendance && todayAttendance.time_out && (
              <div className="attendance-action completed">
                <div className="completed-icon">
                  <img src={checkPhoto} alt="Attendance complete" />
                </div>

                <h3>Attendance Complete</h3>

                <p>
                  Time In: <strong>{formatTime(todayAttendance.time_in)}</strong>
                </p>

                <p>
                  Time Out:{" "}
                  <strong>{formatTime(todayAttendance.time_out)}</strong>
                </p>

                <p className="success-text">
                  Your attendance for today is complete.
                </p>
              </div>
            )}

            {/* NEW: SAVE A COPY OF THE CONFIRMED SELFIE */}
            {savedPhoto && !cameraOpen && !photo && (
              <div className="photo-preview-container">
                <img
                  src={savedPhoto.url}
                  alt="Your attendance photo"
                  className="photo-preview"
                />

                <p>
                  Photos are kept for a limited time. Save a copy for your own
                  records.
                </p>

                <button
                  className="secondary-button"
                  onClick={savePhotoToGallery}
                >
                  Save photo to gallery
                </button>
              </div>
            )}

            {/* MESSAGE */}
            {message && (
              <div className={`message ${messageType}`}>{message}</div>
            )}

            {/* CHANGE STUDENT */}
            <button
              className="secondary-button"
              onClick={clearStudent}
              disabled={loading}
            >
              Use Another Student ID
            </button>
          </section>
        )}
      </main>

      <footer>
        FON Supreme Student Council
        {" · "}
        <button
          type="button"
          onClick={() => setShowNotice(true)}
          style={{
            padding: 0,
            border: "none",
            background: "none",
            color: "inherit",
            font: "inherit",
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          Privacy Notice
        </button>
      </footer>
    </div>
  );
}

// --------------------------------------------------
// LAST NAME FOR FILENAME
// "Salleh, John Kenneth" -> "salleh"
// "De Guzman, Ana"       -> "de-guzman"
// --------------------------------------------------

function getLastName(fullName) {
  const lastName = (fullName || "").split(",")[0];

  return (
    lastName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "student"
  );
}

// --------------------------------------------------
// FORMAT TIME
// --------------------------------------------------

function formatTime(timestamp) {
  if (!timestamp) return "";

  return new Date(timestamp).toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });
}

export default AttendancePage;