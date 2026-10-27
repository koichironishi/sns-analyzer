"use client";
export function PrintButton() {
  return <button type="button" className="btn sm" onClick={() => window.print()}>PDFで保存・印刷</button>;
}
