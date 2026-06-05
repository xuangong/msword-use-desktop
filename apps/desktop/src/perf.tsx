import React from "react";
import ReactDOM from "react-dom/client";
import { PerfPanel } from "./PerfPanel";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <div className="h-screen w-screen overflow-hidden">
      <PerfPanel />
    </div>
  </React.StrictMode>,
);
