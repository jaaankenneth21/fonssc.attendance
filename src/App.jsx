import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import AttendancePage from "./pages/AttendancePage";
import AdminLogin from "./pages/AdminLogin";
import AdminDashboard from "./pages/AdminDashboard";
import AdminStudents from "./pages/AdminStudents";
import AdminReports from "./pages/AdminReports";
import AdminSessionHistory from "./pages/AdminSessionHistory";

import "./styles.css";

function ProtectedAdminRoute({ children }) {
  const session = localStorage.getItem("adminSession");

  if (!session) {
    return <Navigate to="/admin" replace />;
  }

  return children;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>

        {/* Student Attendance */}
        <Route
          path="/"
          element={<AttendancePage />}
        />

        {/* Admin Login */}
        <Route
          path="/admin"
          element={<AdminLogin />}
        />

        {/* Protected Admin Dashboard */}
        <Route
          path="/admin/dashboard"
          element={
            <ProtectedAdminRoute>
              <AdminDashboard />
            </ProtectedAdminRoute>
          }
        />

        {/* Protected Admin Students */}
        <Route
          path="/admin/students"
          element={
            <ProtectedAdminRoute>
              <AdminStudents />
            </ProtectedAdminRoute>
          }
        />

        {/* Protected Admin Session History */}
        <Route
          path="/admin/sessions"
          element={
            <ProtectedAdminRoute>
              <AdminSessionHistory />
            </ProtectedAdminRoute>
          }
        />

        {/* Protected Admin Reports */}
        <Route
          path="/admin/reports"
          element={
            <ProtectedAdminRoute>
              <AdminReports />
            </ProtectedAdminRoute>
          }
        />

        {/* Unknown URL */}
        <Route
          path="*"
          element={<Navigate to="/" replace />}
        />

      </Routes>
    </BrowserRouter>
  );
}

export default App;