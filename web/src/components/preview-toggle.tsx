"use client";
import { useState } from "react";

/**
 * 投稿一覧の「確認」ボタン。カードの下の中身（画像と全文）を開け閉めする。
 * 中身はサーバーで描き、hidden で隠しておく（ボタンを複製・削除と横に並べるため、details ではなくボタンにした）
 */
export function PreviewToggle({ panelId, initialOpen, detail }: { panelId: string; initialOpen: boolean; detail: string }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <button type="button" className="btn sm preview-toggle" aria-expanded={open} aria-controls={panelId}
      onClick={() => {
        const next = !open;
        const panel = document.getElementById(panelId);
        if (panel) panel.hidden = !next;
        setOpen(next);
      }}>
      確認<span className="sr-only">（{detail}を{open ? "閉じる" : "表示する"}）</span>
    </button>
  );
}
