import ReactDOM from "react-dom/client";
import App from "./App";

// StrictMode disabled: Tauri's listen() returns a Promise<unsubscribe>, so
// the cleanup `void off.then(u => u())` resolves async. StrictMode's
// intentional double-mount in dev meant the first listener stayed alive into
// the second mount → every bun:reply event dispatched twice → text_delta /
// tool_call / etc. all duplicated in the UI. The cheap, correct fix is to
// drop StrictMode for this app — we don't gain its checks anywhere that
// matters here. If we want it back, we'd need a synchronous unsubscribe
// mechanism (e.g. a ref-counted listener registry).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
