import React from "react";
import { createRoot } from "react-dom/client";
import { PromiseBondApp } from "./features/promisebond/components/PromiseBondApp";
import "./promisebond.css";

type PromiseBondWindow = Window & {
  __promiseBondRoot?: ReturnType<typeof createRoot>;
};

const rootElement = document.getElementById("root")!;
const promiseBondWindow = window as PromiseBondWindow;
const root = promiseBondWindow.__promiseBondRoot ?? createRoot(rootElement);
promiseBondWindow.__promiseBondRoot = root;
root.render(<PromiseBondApp />);
