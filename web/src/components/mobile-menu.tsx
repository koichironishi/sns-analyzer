"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/*
 * スマホ・タブレットのメニュー（左から出るドロワー。MEO と同じ形）。
 * 開閉は body の data-menu で表し、ドロワー本体（左メニュー .side か、全体メニュー .app-drawer）は CSS で出し分ける。
 */
const EVENT = "rw-menu";
const setMenu = (open: boolean) => {
  if (open) document.body.dataset.menu = "open";
  else delete document.body.dataset.menu;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: open }));
};

/** ☰ ボタン（上バー） */
export function MenuButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <button type="button" className="menu-btn" aria-label="メニューを開く" aria-expanded={open} onClick={() => setMenu(true)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
  );
}

/** × ボタン（ドロワーの中） */
export function MenuClose() {
  return (
    <button type="button" className="menu-close" aria-label="メニューを閉じる" onClick={() => setMenu(false)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  );
}

/** 背景の暗幕と、閉じる条件（画面の移動・Esc・メニュー内のリンク） */
export function MenuBackdrop() {
  const path = usePathname();
  useEffect(() => { setMenu(false); }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    // 同じ画面へのリンクでは path が変わらないため、クリックでも閉じる
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(".side a, .app-drawer a")) setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("click", onClick); };
  }, []);
  return <button type="button" className="drawer-backdrop" aria-label="メニューを閉じる" tabIndex={-1} onClick={() => setMenu(false)} />;
}
