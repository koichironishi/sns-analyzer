"use client";
import { useState } from "react";
import { PLATFORM_LABELS, type Platform } from "@/lib/sns/models";

export type PreviewTarget = { platform: Platform; name: string };

/**
 * 作成中の投稿が、各SNSでどう見えるかの見本。入力に合わせてその場で変わる。
 * 実際の見た目は SNS のアプリや画面の大きさで変わるため、「おおよその形」と明記する。
 * - Instagram：画像（複数枚は横にめくる）→ 本文。本文は2行ほどで「…続きを読む」になる
 * - Facebook：本文 → 画像（複数枚は並べて表示）
 * - Threads：本文 → 画像（複数枚は横に並ぶ）
 * - ストーリーズ：縦長（9:16）の画面に画像だけ
 */
export function PostPreview({ targets, textOf, images, story }: {
  targets: PreviewTarget[];
  textOf: (p: Platform) => string;
  images: string[];
  story: boolean;
}) {
  const platforms = [...new Set(targets.map((t) => t.platform))];
  const [cur, setCur] = useState<Platform | null>(null);
  const [slide, setSlide] = useState(0);
  const [more, setMore] = useState(false);
  const p = cur && platforms.includes(cur) ? cur : platforms[0];
  if (!p) return <p className="muted small" style={{ margin: 0 }}>投稿先を選ぶと、ここに見本が出ます。</p>;
  const name = targets.find((t) => t.platform === p)?.name || PLATFORM_LABELS[p];
  const text = textOf(p);
  const i = Math.min(slide, Math.max(0, images.length - 1));
  const go = (d: number) => setSlide((s) => Math.max(0, Math.min(images.length - 1, Math.min(s, images.length - 1) + d)));
  const head = (
    <div className="pv-head">
      <span className="pv-avatar" aria-hidden="true">{name.replace(/^@/, "").slice(0, 1).toUpperCase()}</span>
      <span className="pv-name">{name.replace(/^@/, "")}</span>
    </div>
  );
  const carousel = (
    <div className="pv-media">
      {images.length ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={images[i]} alt={`${i + 1}枚目の見本`} />
          {images.length > 1 && (
            <>
              <span className="pv-count" aria-hidden="true">{i + 1}/{images.length}</span>
              <button type="button" className="pv-nav prev" onClick={() => go(-1)} disabled={i === 0} aria-label="前の画像">‹</button>
              <button type="button" className="pv-nav next" onClick={() => go(1)} disabled={i === images.length - 1} aria-label="次の画像">›</button>
              <span className="pv-dots" aria-hidden="true">{images.map((_, n) => <i key={n} className={n === i ? "on" : undefined} />)}</span>
            </>
          )}
        </>
      ) : <span className="pv-noimg">{p === "instagram" ? "Instagram は画像が必要です" : "画像なし"}</span>}
    </div>
  );
  // 本文の省略：Instagram は2行（約60文字）、Facebook・Threads は長いときだけ「…もっと見る」
  const limit = p === "instagram" ? 60 : 300;
  const long = text.length > limit;
  const body = (
    <p className="pv-text">
      {p === "instagram" && <strong>{name.replace(/^@/, "")} </strong>}
      {long && !more ? <>{text.slice(0, limit)}… <button type="button" className="pv-more" onClick={() => setMore(true)}>{p === "instagram" ? "続きを読む" : "もっと見る"}</button></> : text}
      {!text.trim() && <span className="muted">（本文なし）</span>}
    </p>
  );
  return (
    <div className="pv">
      {platforms.length > 1 && (
        <div className="tabs pv-tabs" role="tablist" aria-label="見本を見るSNS">
          {platforms.map((x) => (
            <button key={x} type="button" role="tab" className="tab" aria-selected={x === p} onClick={() => { setCur(x); setSlide(0); setMore(false); }}>
              <i className="dot" style={{ background: `var(--c-${x})` }} aria-hidden="true" />{PLATFORM_LABELS[x]}
            </button>
          ))}
        </div>
      )}
      <div className={`pv-phone pv-${story ? "story" : p}`} aria-label={`${PLATFORM_LABELS[p]}${story ? "のストーリーズ" : ""}の見本`} role="group">
        {story ? (
          <div className="pv-storyframe">
            <div className="pv-storybar">{images.map((_, n) => <i key={n} className={n <= i ? "on" : undefined} />)}</div>
            {head}
            {images.length ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={images[i]} alt={`${i + 1}枚目のストーリーズの見本`} />
                {images.length > 1 && (
                  <>
                    <button type="button" className="pv-nav prev" onClick={() => go(-1)} disabled={i === 0} aria-label="前のストーリーズ">‹</button>
                    <button type="button" className="pv-nav next" onClick={() => go(1)} disabled={i === images.length - 1} aria-label="次のストーリーズ">›</button>
                  </>
                )}
              </>
            ) : <span className="pv-noimg">画像を入れてください</span>}
          </div>
        ) : p === "instagram" ? (
          <>{head}{carousel}<div className="pv-actions" aria-hidden="true">♡　💬　➤</div>{body}</>
        ) : (
          <>{head}{body}{images.length > 1 && p === "facebook" ? (
            <div className={`pv-grid n${Math.min(images.length, 4)}`}>
              {images.slice(0, 4).map((src, n) => (
                <span key={n} className="pv-cell">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`${n + 1}枚目の見本`} />
                  {n === 3 && images.length > 4 && <span className="pv-more-n">+{images.length - 4}</span>}
                </span>
              ))}
            </div>
          ) : images.length ? carousel : null}</>
        )}
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        おおよその見た目です。文字の折り返しや省略の位置は、スマホの大きさやアプリによって変わります。
        {!story && " 計測用の印（UTM）を付ける設定のときは、付けたあとのリンクで表示しています。"}
      </p>
    </div>
  );
}
