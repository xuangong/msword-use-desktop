import ReactDOM from "react-dom/client";
import SpotlightApp from "./SpotlightApp";
import "./App.css";

// StrictMode disabled — see main.tsx for rationale (Tauri listen()
// async-cleanup races StrictMode's double-mount, causing every event
// to fire twice).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <SpotlightApp />,
);
