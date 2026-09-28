"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="app-main narrow" tabIndex={-1}>
      <h1 className="page-title">エラーが発生しました</h1>
      <div className="msg error" role="alert">
        表示中に問題が発生しました。時間をおいて、もう一度お試しください。{error.digest && <>（エラー番号：{error.digest}）</>}
      </div>
      <button type="button" className="btn" onClick={reset}>もう一度読み込む</button>
    </main>
  );
}
