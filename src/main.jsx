import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/colors_and_type.css";
import "./styles/app.css";
import "./overview.css";
import "./wages.css";
import Shell from "./Shell.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>
);
