"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * 横にスクロールする表（.scroll）を、はみ出しているときだけキーボードで操作できるようにする。
 * （Safari・Firefox ではフォーカスできない要素をキーボードでスクロールできないため）
 */
export function ScrollRegions() {
  const path = usePathname();
  const sp = useSearchParams();
  useEffect(() => {
    const label = (el: HTMLElement) => {
      const cap = el.querySelector("caption")?.textContent?.trim();
      const h = el.closest("section")?.querySelector("h2")?.textContent?.trim();
      return `${el.dataset.label ?? cap ?? h ?? "表"}（横にスクロールできます）`;
    };
    const update = () => {
      document.querySelectorAll<HTMLElement>(".scroll").forEach((el) => {
        if (el.scrollWidth > el.clientWidth + 1) {
          el.tabIndex = 0;
          el.setAttribute("role", "region");
          el.setAttribute("aria-label", label(el));
        } else if (el.getAttribute("role") === "region") {
          el.removeAttribute("tabindex");
          el.removeAttribute("role");
          el.removeAttribute("aria-label");
        }
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    const mo = new MutationObserver(update);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [path, sp]);
  return null;
}
