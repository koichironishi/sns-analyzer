"use client";

/** 公開し直したあと、古い画面のまま操作すると Server Action が見つからずに失敗する */
const isStale = (e: Error) => /Server Action|failed to find|Failed to fetch|ChunkLoadError|Loading chunk/i.test(e.message);

export default function ErrorPage({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = !error.digest && isStale(error);
  return (
    <main id="main" className="app-main narrow" tabIndex={-1}>
      <h1 className="page-title">エラーが発生しました</h1>
      <div className="msg error" role="alert">
        {stale
          ? "アプリが新しい版に更新されたため、操作を完了できませんでした。ページを再読み込みしてから、もう一度操作してください（入力内容は保存されていません）。"
          : <>表示中に問題が発生しました。時間をおいて、もう一度お試しください。{error.digest && <>（エラー番号：{error.digest}）</>}</>}
        {/* ブラウザ側のエラーは原因の手がかりとして内容を出す（サーバー側のエラーは番号のみ） */}
        {!error.digest && !stale && error.message && <><br /><span className="small">詳細：{error.message.slice(0, 200)}</span></>}
      </div>
      {/* 古い画面が原因のことがあるため、画面の再描画ではなくページごと読み込み直す */}
      <button type="button" className="btn" onClick={() => window.location.reload()}>ページを再読み込みする</button>
    </main>
  );
}
