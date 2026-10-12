"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createUploadTarget, savePost, type SavePostInput } from "@/app/(app)/clients/[id]/publish/actions";
import { LIMITS, textLength } from "@/lib/sns/publish/rules";
import { PLATFORMS, PLATFORM_LABELS, type Platform } from "@/lib/sns/models";

export type ComposerConnection = { platform: Platform; connected: boolean; canPublish: boolean; username: string | null };
type Img = { key: string; path: string | null; previewUrl: string; width: number; height: number; uploading: boolean; error?: string };

const MAX_SIDE = 1440;

/** 画像を JPEG（長い辺 1440px まで）に変換する。Instagram は JPEG しか受け付けないため */
async function toJpeg(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // 透過部分は白にする
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) throw new Error("画像を変換できませんでした");
  return { blob, width, height };
}

function localNow(offsetMin = 0) {
  const d = new Date(Date.now() + offsetMin * 60_000);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function PostComposer({ clientId, connections, initial, needsApproval = false }: {
  clientId: string;
  connections: ComposerConnection[];
  needsApproval?: boolean;
  initial?: { id: string; text: string; platformTexts: Partial<Record<Platform, string>>; platforms: Platform[]; media: { path: string; url: string }[]; scheduledLocal: string | null };
}) {
  const router = useRouter();
  const usable = (p: Platform) => connections.find((c) => c.platform === p);
  const [platforms, setPlatforms] = useState<Platform[]>(initial?.platforms ?? connections.filter((c) => c.canPublish).map((c) => c.platform));
  const [text, setText] = useState(initial?.text ?? "");
  const [perText, setPerText] = useState<Partial<Record<Platform, string>>>(initial?.platformTexts ?? {});
  const [images, setImages] = useState<Img[]>(initial?.media.map((m, i) => ({ key: `i${i}`, path: m.path, previewUrl: m.url, width: 0, height: 0, uploading: false })) ?? []);
  const [mode, setMode] = useState<SavePostInput["mode"]>(initial?.scheduledLocal ? "schedule" : "now");
  const [when, setWhen] = useState(initial?.scheduledLocal ?? localNow(60));
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (errors.length) errRef.current?.focus(); }, [errors]);

  const textOf = (p: Platform) => ((perText[p] ?? "").trim() ? perText[p]! : text);
  const uploading = images.some((i) => i.uploading);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const room = 10 - images.length;
    const list = [...files].slice(0, Math.max(0, room));
    if (files.length > room) setErrors([`画像は10枚までです（${files.length - list.length}枚は追加していません）`]);
    for (const file of list) {
      const key = `${Date.now()}-${Math.random()}`;
      const previewUrl = URL.createObjectURL(file);
      setImages((cur) => [...cur, { key, path: null, previewUrl, width: 0, height: 0, uploading: true }]);
      try {
        if (!file.type.startsWith("image/")) throw new Error("画像ファイルを選んでください");
        const { blob, width, height } = await toJpeg(file);
        const target = await createUploadTarget(clientId);
        if (!target.ok) throw new Error(target.errors[0]);
        const res = await fetch(target.signedUrl, { method: "PUT", headers: { "content-type": "image/jpeg", "x-upsert": "false" }, body: blob });
        if (!res.ok) throw new Error(`アップロードに失敗しました（${res.status}）`);
        setImages((cur) => cur.map((i) => (i.key === key ? { ...i, path: target.path, width, height, uploading: false } : i)));
      } catch (e) {
        setImages((cur) => cur.map((i) => (i.key === key ? { ...i, uploading: false, error: e instanceof Error ? e.message : "アップロードに失敗しました" } : i)));
      }
    }
  }

  const move = (idx: number, d: -1 | 1) => setImages((cur) => {
    const next = [...cur];
    const [x] = next.splice(idx, 1);
    next.splice(idx + d, 0, x);
    return next;
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (uploading) return setErrors(["画像のアップロードが終わるまでお待ちください"]);
    const bad = images.filter((i) => !i.path);
    if (bad.length) return setErrors(["アップロードに失敗した画像を削除してから、もう一度お試しください"]);
    setErrors([]);
    setBusy("保存しています…");
    const r = await savePost({
      clientId, id: initial?.id, text, platformTexts: perText, platforms, mediaPaths: images.map((i) => i.path!), mode, scheduledLocal: when,
    });
    if (!r.ok) { setBusy(null); return setErrors(r.errors); }
    if (r.pending) {
      router.push(`/clients/${clientId}/publish?ok=pending`);
    } else if (r.publishNow) {
      setBusy("投稿しています…（画像の処理などで1分ほどかかることがあります）");
      const res = await fetch(`/api/clients/${clientId}/posts/${r.id}/publish`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      router.push(`/clients/${clientId}/publish?ok=${res.ok ? body.status : "publish_error"}`);
    } else {
      router.push(`/clients/${clientId}/publish?ok=${mode === "draft" ? "draft" : "scheduled"}`);
    }
    router.refresh();
  }

  const ratioWarn = (i: Img) => platforms.includes("instagram") && i.width > 0 && (i.width / i.height < 0.8 || i.width / i.height > 1.91);

  return (
    <form className="stack" onSubmit={submit} aria-busy={Boolean(busy)}>
      {errors.length > 0 && (
        <div className="msg error" role="alert" tabIndex={-1} ref={errRef}>
          <ul style={{ margin: 0, paddingLeft: "1.2em" }}>{errors.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      <fieldset className="card" style={{ margin: 0 }}>
        <legend>投稿先</legend>
        <div className="checks">
          {PLATFORMS.map((p) => {
            const c = usable(p);
            const disabled = !c?.connected || !c.canPublish;
            const note = !c?.connected ? "未連携" : !c.canPublish ? "投稿の許可なし（再連携が必要）" : c.username ? `@${c.username}` : "";
            return (
              <label key={p} className="check" style={{ opacity: disabled ? 0.7 : 1 }}>
                <input type="checkbox" checked={platforms.includes(p)} disabled={disabled}
                  onChange={(e) => setPlatforms((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))} />
                {PLATFORM_LABELS[p]}<span className="small muted">{note && `（${note}）`}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="card">
        <label htmlFor="post-text" style={{ marginTop: 0 }}>本文</label>
        <textarea id="post-text" value={text} onChange={(e) => setText(e.target.value)} rows={7} aria-describedby="post-count" />
        <ul className="legend" id="post-count" aria-live="polite" style={{ marginTop: 8 }}>
          {platforms.map((p) => {
            const n = textLength(p, textOf(p));
            const over = n > LIMITS[p].maxText;
            return <li key={p} style={over ? { color: "var(--warn)", fontWeight: 700 } : undefined}>{PLATFORM_LABELS[p]} {n.toLocaleString()} / {LIMITS[p].maxText.toLocaleString()}{over && "（超えています）"}</li>;
          })}
        </ul>
        {platforms.includes("x") && <p className="hint">X は日本語を1文字＝2として数えます（全角140文字まで）。</p>}
        {platforms.length > 0 && (
          <details className="more">
            <summary>SNSごとに本文を変える</summary>
            {platforms.map((p) => (
              <div key={p}>
                <label htmlFor={`pt-${p}`}>{PLATFORM_LABELS[p]}用の本文（空なら上の本文を使います）</label>
                <textarea id={`pt-${p}`} rows={4} value={perText[p] ?? ""} onChange={(e) => setPerText((cur) => ({ ...cur, [p]: e.target.value }))} />
              </div>
            ))}
          </details>
        )}
      </div>

      <div className="card">
        <label htmlFor="post-images" style={{ marginTop: 0 }}>画像（10枚まで。X は4枚まで、Instagram は1枚以上必要）</label>
        <input id="post-images" type="file" accept="image/*" multiple disabled={images.length >= 10} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} aria-describedby="img-hint" />
        <p className="hint" id="img-hint">JPEG に変換し、長い辺を1440pxまでに縮小してからアップロードします。Instagram は縦横比 4:5〜1.91:1 の画像だけ投稿できます。</p>
        {images.length > 0 && (
          <ol className="thumbs">
            {images.map((img, i) => (
              <li key={img.key}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.previewUrl} alt={`画像${i + 1}`} />
                <div className="small">
                  {img.uploading ? <span className="progress"><span className="spinner" aria-hidden="true" />アップロード中…</span>
                    : img.error ? <span style={{ color: "var(--warn)" }}>{img.error}</span>
                    : ratioWarn(img) ? <span style={{ color: "var(--warn)" }}>この縦横比は Instagram に投稿できません</span> : `画像${i + 1}`}
                </div>
                <div className="row">
                  <button type="button" className="btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`画像${i + 1}を前へ`}>←</button>
                  <button type="button" className="btn sm" onClick={() => move(i, 1)} disabled={i === images.length - 1} aria-label={`画像${i + 1}を後ろへ`}>→</button>
                  <button type="button" className="btn sm danger" onClick={() => setImages((cur) => cur.filter((x) => x.key !== img.key))} aria-label={`画像${i + 1}を外す`}>外す</button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <fieldset className="card" style={{ margin: 0 }}>
        <legend>投稿のタイミング</legend>
        {needsApproval && <p className="hint" style={{ marginTop: 0 }}>この投稿は、担当者の承認を経てから公開されます。「今すぐ投稿」は承認されたときに、「予約」は承認後の予約日時に投稿します。</p>}
        <div className="checks" role="radiogroup" aria-label="投稿のタイミング">
          <label className="check"><input type="radio" name="mode" checked={mode === "now"} onChange={() => setMode("now")} />今すぐ投稿</label>
          <label className="check"><input type="radio" name="mode" checked={mode === "schedule"} onChange={() => setMode("schedule")} />日時を指定して予約</label>
          <label className="check"><input type="radio" name="mode" checked={mode === "draft"} onChange={() => setMode("draft")} />下書きとして保存</label>
        </div>
        {mode === "schedule" && (
          <>
            <label htmlFor="post-when">予約日時（日本時間）</label>
            <input id="post-when" type="datetime-local" value={when} min={localNow(2)} onChange={(e) => setWhen(e.target.value)} aria-describedby="when-hint" />
            <p className="hint" id="when-hint">予約時刻から数分以内に投稿します。</p>
          </>
        )}
      </fieldset>

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={Boolean(busy) || uploading} aria-disabled={Boolean(busy) || uploading}>
          {busy ? <><span className="spinner" aria-hidden="true" />{busy}</> : mode === "draft" ? "下書きを保存"
            : needsApproval ? "承認を依頼する" : mode === "now" ? "今すぐ投稿する" : "予約する"}
        </button>
        <a className="btn ghost" href={`/clients/${clientId}/publish`}>キャンセル</a>
      </div>
      <div aria-live="polite" className="sr-only">{busy ?? ""}</div>
    </form>
  );
}
