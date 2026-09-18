import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

const ScheduleMockup = lazy(() => import("./ScheduleMockup.jsx"));

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      {window.location.pathname === "/mockup" ? <ScheduleMockup /> : <App />}
    </Suspense>
  </StrictMode>
);
