import { createRoot } from "react-dom/client";
import { App } from "./workbench.js";
import "./style.css";

createRoot(document.getElementById("root")!).render(<App />);
