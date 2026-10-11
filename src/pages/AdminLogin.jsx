import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import pinklogo from "../assets/pinklogo.png";
import "../admin.css";

/* ---------- Icons ---------- */

function Icon({ children, size = 18, strokeWidth = 1.8 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function EyeIcon({ off }) {
  return (
    <Icon size={20}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </Icon>
  );
}

function MailIcon() {
  return (
    <Icon>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m4 7 8 6 8-6" />
    </Icon>
  );
}

function LockIcon() {
  return (
    <Icon>
      <rect x="4" y="11" width="16" height="9" rx="3" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

function ArrowIcon() {
  return (
    <Icon size={18} strokeWidth={2.2}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  );
}

function ShieldIcon() {
  return (
    <Icon size={14} strokeWidth={2}>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

/* Floating background particles (purely decorative) */
const PARTICLES = [
  { x: "6%", s: 12, d: 17, delay: 0, ring: false },
  { x: "17%", s: 8, d: 13, delay: 3, ring: true },
  { x: "29%", s: 16, d: 21, delay: 6, ring: true },
  { x: "41%", s: 7, d: 15, delay: 1, ring: false },
  { x: "55%", s: 14, d: 19, delay: 8, ring: false },
  { x: "67%", s: 9, d: 14, delay: 4, ring: true },
  { x: "78%", s: 18, d: 23, delay: 2, ring: true },
  { x: "88%", s: 10, d: 16, delay: 7, ring: false },
  { x: "95%", s: 7, d: 12, delay: 5, ring: true },
];

function AdminLogin() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  function handlePasswordKey(event) {
    if (event.getModifierState) {
      setCapsOn(event.getModifierState("CapsLock"));
    }
  }

  async function handleLogin(event) {
    event.preventDefault();

    setMessage("");

    if (!email.trim()) {
      setMessage("Please enter your email.");
      return;
    }

    if (!password) {
      setMessage("Please enter your password.");
      return;
    }

    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        throw error;
      }

      if (!data.session) {
        throw new Error("Login succeeded, but no session was created.");
      }

      localStorage.setItem("adminSession", "true");

      navigate("/admin/dashboard", { replace: true });
    } catch (error) {
      console.error("Admin login error:", error);

      setMessage(
        error.message ||
          "Unable to sign in. Please check your email and password."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login-page">
      {/* Ambient background */}
      <div className="admin-login-blob admin-login-blob--one" aria-hidden="true" />
      <div className="admin-login-blob admin-login-blob--two" aria-hidden="true" />
      <div className="admin-login-grid" aria-hidden="true" />

      <div className="admin-login-particles" aria-hidden="true">
        {PARTICLES.map((p, index) => (
          <span
            key={index}
            className={`admin-particle${p.ring ? " admin-particle--ring" : ""}`}
            style={{
              "--x": p.x,
              "--s": `${p.s}px`,
              "--d": `${p.d}s`,
              "--delay": `-${p.delay}s`,
            }}
          />
        ))}
      </div>

      <div className="admin-login-stage">
        <main className="admin-login-card">
          {/* Logo badge */}
          <div className="admin-login-logo">
            <div className="admin-logo-disc">
              <img src={pinklogo} alt="Student Attendance System logo" />
            </div>
          </div>

          <header className="admin-login-heading">
            <span className="admin-login-eyebrow admin-reveal" style={{ "--i": 1 }}>
              Admin Portal
            </span>
            <h1 className="admin-reveal" style={{ "--i": 2 }}>
              Admin Login
            </h1>
            <p className="admin-reveal" style={{ "--i": 3 }}>
              Student Attendance System
            </p>
          </header>

          <form className="admin-login-form" onSubmit={handleLogin} noValidate>
            <div className="admin-form-group admin-reveal" style={{ "--i": 4 }}>
              <label htmlFor="admin-email">Email:</label>
              <div className="admin-input-wrap">
                <span className="admin-input-icon">
                  <MailIcon />
                </span>
                <input
                  id="admin-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="email"
                  disabled={loading}
                  aria-invalid={Boolean(message) && !email.trim()}
                />
              </div>
            </div>

            <div className="admin-form-group admin-reveal" style={{ "--i": 5 }}>
              <label htmlFor="admin-password">Password:</label>
              <div className="admin-input-wrap">
                <span className="admin-input-icon">
                  <LockIcon />
                </span>
                <input
                  id="admin-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={handlePasswordKey}
                  onKeyUp={handlePasswordKey}
                  onBlur={() => setCapsOn(false)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  disabled={loading}
                  aria-invalid={Boolean(message) && !password}
                />
                <button
                  type="button"
                  className="admin-password-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  disabled={loading}
                >
                  <EyeIcon off={showPassword} />
                </button>
              </div>

              {capsOn && (
                <p className="admin-caps-hint" role="status">
                  Caps Lock is on
                </p>
              )}
            </div>

            {message && (
              <div className="admin-login-error" role="alert">
                <Icon size={18} strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5M12 16.5v.01" />
                </Icon>
                <span>{message}</span>
              </div>
            )}

            <button
              type="submit"
              className="admin-sign-in-button admin-reveal"
              style={{ "--i": 6 }}
              disabled={loading}
              aria-busy={loading}
            >
              {loading && <span className="admin-spinner" aria-hidden="true" />}
              <span>{loading ? "Signing in..." : "Sign In"}</span>
              {!loading && (
                <span className="admin-button-arrow">
                  <ArrowIcon />
                </span>
              )}
            </button>
          </form>

          <p className="admin-login-footer admin-reveal" style={{ "--i": 7 }}>
            <ShieldIcon />
            <span>Authorized administrators only</span>
          </p>
        </main>
      </div>
    </div>
  );
}

export default AdminLogin;