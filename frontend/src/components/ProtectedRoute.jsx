import React from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  // loading = still waiting for /api/auth/me to resolve — show nothing to avoid flash
  if (loading) return null;
  // No user = no valid session cookie → redirect to login
  if (!user)   return <Navigate to="/login" replace />;
  return children;
}
