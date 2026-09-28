import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { LEGAL_FIELDS, OPTIONAL_LEGAL, type LegalKey } from "@/lib/legal-fields";
import { createAdminClient } from "@/lib/supabase/admin";
import { AI_EFFORTS, AI_MODELS } from "@/lib/sns/ai";
import { getAppSettings } from "@/lib/sns/store";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { saveAppSettings } from "./actions";

export const metadata: Metadata = { title: "全体設定" };

const EFFORT_LABELS = { low: "低（速い・安い）", medium: "中", high: "高（推奨）" } as const;

export default async function AdminPage() {
  await requireAdmin();
  const s = await getAppSettings(createAdminClient());
  const missing = (Object.keys(LEGAL_FIELDS) as LegalKey[]).filter((k) => !OPTIONAL_LEGAL.includes(k) && !s.legal[k]);
  return (
    <main id="main" className="app-main narrow" tabIndex={-1}>
      <h1 className="page-title">全体設定</h1>
      <p className="sub">すべてのクライアントに共通の設定です（管理者のみ）。</p>
      <ActionForm action={saveAppSettings} className="stack">
        <section className="card" aria-labelledby="h-collect">
          <h2 id="h-collect" style={{ fontSize: "var(--fs-lg)", margin: 0 }}>データ収集と保存</h2>
          <label htmlFor="retention">保存期間（日）</label>
          <input id="retention" name="retention_days" type="number" min={0} max={3650} defaultValue={s.retention_days} aria-describedby="retention-hint" />
          <p className="hint" id="retention-hint">この日数を過ぎた投稿・指標・フォロワー記録・AI分析結果は、毎日の収集時に自動で削除します。0にすると自動では削除しません（プライバシーポリシーの記載も変わります）。</p>
          <label htmlFor="collect">収集の対象期間（日）</label>
          <input id="collect" name="collect_days" type="number" min={1} max={365} defaultValue={s.collect_days} aria-describedby="collect-hint" />
          <p className="hint" id="collect-hint">この期間の投稿の指標を毎日取り直し、SNS上で削除された投稿は本サービスからも削除します。</p>
          <label htmlFor="maxposts">1回あたりの取得件数の上限（SNSごと）</label>
          <input id="maxposts" name="max_posts_per_run" type="number" min={1} max={2000} defaultValue={s.max_posts_per_run} />
          <label htmlFor="graph">Meta Graph API のバージョン</label>
          <input id="graph" name="graph_api_version" type="text" defaultValue={s.graph_api_version} pattern="v\d{2}\.\d" />
        </section>
        <section className="card" aria-labelledby="h-ai">
          <h2 id="h-ai" style={{ fontSize: "var(--fs-lg)", margin: 0 }}>AI分析</h2>
          <label htmlFor="model">モデル</label>
          <select id="model" name="ai_model" defaultValue={s.ai_model}>{AI_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          <label htmlFor="effort">分析の深さ</label>
          <select id="effort" name="ai_effort" defaultValue={s.ai_effort}>{AI_EFFORTS.map((e) => <option key={e} value={e}>{EFFORT_LABELS[e]}</option>)}</select>
        </section>
        <section className="card" aria-labelledby="h-legal">
          <h2 id="h-legal" style={{ fontSize: "var(--fs-lg)", margin: 0 }}>プライバシーポリシー・利用規約の事業者情報</h2>
          {missing.length > 0 && <div className="msg error" role="alert" style={{ marginTop: 12 }}>未記入の項目があります（{missing.map((k) => LEGAL_FIELDS[k]).join("、")}）。公開前に入力し、専門家の確認を受けてください。</div>}
          {(Object.keys(LEGAL_FIELDS) as LegalKey[]).map((k) => (
            <div key={k}>
              <label htmlFor={`legal-${k}`}>{LEGAL_FIELDS[k]}</label>
              {k === "org_measures"
                ? <textarea id={`legal-${k}`} name={`legal_${k}`} defaultValue={s.legal[k] ?? ""} maxLength={1000} />
                : <input id={`legal-${k}`} name={`legal_${k}`} type="text" defaultValue={s.legal[k] ?? ""} maxLength={1000} />}
            </div>
          ))}
        </section>
        <div className="form-actions"><SubmitButton pendingText="保存しています…">保存</SubmitButton></div>
      </ActionForm>
    </main>
  );
}
