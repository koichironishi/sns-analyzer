"""プライバシーポリシー（本サービスの実際の動作に合わせた文面）。

事業者名・住所などは config.json の privacy_policy で設定する。未設定の項目は
「【要記入】」と表示し、公開前に気づけるようにする（架空の値は入れない）。
文面は法的助言ではない。公開前に専門家の確認を受けること。
"""
from __future__ import annotations

from html import escape as e

from .privacy import retention_days

POLICY_FIELDS = {
    "service_name": "サービス名",
    "operator_name": "事業者名",
    "operator_address": "住所",
    "representative": "代表者",
    "contact": "お問い合わせ窓口（メールアドレスまたはフォームURL）",
    "established": "制定日",
    "server_location": "データを保管するサーバーの所在国",
    "org_measures": "組織的・人的・物理的安全管理措置",
}

US_SYSTEM_URL = "https://www.ppc.go.jp/enforcement/infoprovision/laws/offshore_report_america/"
ANTHROPIC_PRIVACY_URL = "https://www.anthropic.com/legal/privacy"
ANTHROPIC_TRAINING_URL = "https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training"
ANTHROPIC_RETENTION_URL = "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data"


def missing_fields(root_cfg: dict) -> list[str]:
    pp = root_cfg.get("privacy_policy") or {}
    return [label for key, label in POLICY_FIELDS.items() if not str(pp.get(key) or "").strip()]


def warning_html(root_cfg: dict) -> str:
    missing = missing_fields(root_cfg)
    if not missing:
        return ""
    return (f'<div class="msg error" role="alert">未記入の項目があります（{e("、".join(missing))}）。'
            'config.json の privacy_policy に入力し、専門家の確認を受けてから公開してください。</div>')


def render_policy(root_cfg: dict) -> str:
    """本文HTML（見出し以下）を返す。"""
    pp = root_cfg.get("privacy_policy") or {}

    def v(key: str) -> str:
        val = str(pp.get(key) or "").strip()
        return e(val) if val else f'<mark class="todo">【要記入：{POLICY_FIELDS[key]}】</mark>'

    contact = str(pp.get("contact") or "").strip()
    if contact.startswith(("http://", "https://")):
        contact_html = f'<a href="{e(contact)}">{e(contact)}</a>'
    elif "@" in contact:
        contact_html = f'<a href="mailto:{e(contact)}">{e(contact)}</a>'
    else:
        contact_html = v("contact")
    service = v("service_name")
    operator = v("operator_name")
    days = retention_days(root_cfg)
    retention = (f"収集したSNSデータ（投稿・指標・フォロワー数の記録）は、投稿日または記録日から<strong>{days}日</strong>を過ぎたものを自動的に削除します。"
                 if days else "収集したSNSデータの保存期間は、クライアントとの契約で定めます。")
    public_url = str(root_cfg.get("public_url") or "").rstrip("/") or "（本サービスのURL）"
    revised = str(pp.get("revised") or "").strip()


    return f"""<p>{operator}（以下「当社」）は、SNS分析サービス「{service}」（以下「本サービス」）における情報の取扱いについて、個人情報の保護に関する法律その他の関係法令を遵守し、以下のとおりプライバシーポリシーを定めます。本サービスの利用条件は<a href="/terms">利用規約</a>をご覧ください。</p>

<h2 id="operator">1. 事業者情報</h2>
<table class="kv"><tbody>
  <tr><th scope="row">名称</th><td>{operator}</td></tr>
  <tr><th scope="row">住所</th><td>{v("operator_address")}</td></tr>
  <tr><th scope="row">代表者</th><td>{v("representative")}</td></tr>
  <tr><th scope="row">お問い合わせ窓口</th><td>{contact_html}</td></tr>
</tbody></table>

<h2 id="collect">2. 取得する情報</h2>
<p>本サービスは、当社と契約した企業・団体（以下「クライアント」）のSNS運用を分析するためのサービスです。次の情報を取得します。</p>
<h3>（1）クライアントが連携を許可したSNSアカウントの情報</h3>
<p>Instagram、Facebook、Threads、X の公式API（各社が提供する正規の接続手段）を通じて、クライアントの許可の範囲で次の情報を取得します。</p>
<ul>
  <li>アカウント情報：アカウントID、ユーザー名、ページ名、フォロワー数、フォロー数、投稿数</li>
  <li>投稿情報：投稿ID、本文、投稿日時、投稿形式、投稿URL</li>
  <li>投稿ごとの指標：表示回数、リーチ、いいね・リアクション数、コメント・返信数、シェア・リポスト数、保存数、引用数、クリック数（SNSにより取得できる項目は異なります）</li>
  <li>接続情報：各SNSが発行するアクセストークン、連携を許可した方のSNS上のID（Meta・Threads がアプリごとに発行するID。データ削除リクエストの照合に使用します）</li>
</ul>
<h3>（2）競合比較のための公開情報</h3>
<p>クライアントが比較対象として指定したアカウントについて、各SNSの公式APIで公開されている範囲の情報（フォロワー数、公開投稿の本文・投稿日時・形式、いいね数・コメント数などの公開指標）を取得します。Instagram はビジネスアカウントまたはクリエイターアカウントに限ります。非公開の情報は取得しません。</p>
<h3>（3）本サービスの利用者（ログインユーザー）の情報</h3>
<ul>
  <li>ユーザー名、表示名、担当クライアント、権限</li>
  <li>パスワード（復元できない形式に変換（ハッシュ化）して保存し、元のパスワードは保存しません）</li>
  <li>ログイン日時、接続元IPアドレス、操作の記録（ログイン、ユーザー管理、ダウンロード、データ収集・分析の実行、データ削除、同意の記録）</li>
</ul>
<h3>（4）CSVで取り込んだ情報</h3>
<p>クライアントまたは当社がCSVファイルで取り込んだ投稿・指標の情報。</p>

<h2 id="purpose">3. 利用目的</h2>
<ol>
  <li>クライアントのSNS運用の分析、レポートの作成と提供</li>
  <li>投稿の改善提案、競合アカウントとの比較</li>
  <li>AIによる分析（クライアントの同意がある場合に限ります。「5. AI分析のための外部送信」を参照）</li>
  <li>本サービスの提供、ログイン時の本人確認、不正アクセスの防止、セキュリティの確保</li>
  <li>お問い合わせへの対応</li>
  <li>法令に基づく対応</li>
</ol>
<p>取得した情報を広告配信に利用したり、販売したりすることはありません。</p>

<h2 id="share">4. 第三者への提供</h2>
<p>当社は、次の場合を除き、個人データを本人の同意なく第三者に提供しません。</p>
<ul>
  <li>法令に基づく場合</li>
  <li>人の生命・身体・財産の保護のために必要で、本人の同意を得ることが困難な場合</li>
  <li>その他、個人情報の保護に関する法律で認められる場合</li>
</ul>
<p>分析レポートは、そのデータの持ち主であるクライアントと、クライアントが指定した利用者にのみ提供します。</p>

<h2 id="ai">5. AI分析のための外部送信（外国にある事業者）</h2>
<p>本サービスのAI分析機能を使う場合、次のとおり情報を外国の事業者に送信します。<strong>AI分析は、クライアントから送信への同意を得て、その記録がある場合にのみ実行します。</strong>同意はいつでも撤回でき、撤回した場合は保存済みのAI分析結果を削除します。</p>
<table class="kv"><tbody>
  <tr><th scope="row">送信先</th><td>Anthropic, PBC（Claude API）</td></tr>
  <tr><th scope="row">所在国</th><td>アメリカ合衆国</td></tr>
  <tr><th scope="row">送信する情報</th><td>集計した指標、投稿ごとの指標、競合アカウントの公開指標、クライアントが入力した事業内容、AIへの質問文。投稿本文（競合アカウントの公開投稿の本文を含む）は、クライアントが本文の送信にも同意した場合のみ送信します。</td></tr>
  <tr><th scope="row">送信の目的</th><td>投稿の傾向分析と改善提案の作成</td></tr>
  <tr><th scope="row">送信先での取扱い</th><td>Anthropic の商用APIでは、送信データは既定でAIの学習に使われません（<a href="{ANTHROPIC_TRAINING_URL}">Anthropic の説明</a>）。送信データは原則30日以内に削除されます。ただし、利用ポリシー違反と判定された場合（最長2年）や法令上の要請がある場合などの例外があります（<a href="{ANTHROPIC_RETENTION_URL}">保存期間の説明</a>）。詳しくは <a href="{ANTHROPIC_PRIVACY_URL}">Anthropic のプライバシーポリシー</a>をご覧ください。</td></tr>
  <tr><th scope="row">所在国の個人情報保護制度</th><td>アメリカ合衆国には、連邦レベルで包括的な個人情報保護法はなく、分野ごとの法令と州法で保護されています。詳しくは個人情報保護委員会の<a href="{US_SYSTEM_URL}">外国制度（アメリカ合衆国）</a>をご覧ください。</td></tr>
</tbody></table>

<h2 id="sns">6. 各SNSとの関係</h2>
<p>本サービスは、Meta Platforms, Inc.（Facebook、Instagram、Threads）および X Corp.（X）が提供する公式APIを利用して情報を取得します。各SNSでの情報の取扱いは、各社のプライバシーポリシーをご確認ください。本サービスはこれらの会社が提供・承認するものではありません。各サービス名は各社の商標です。</p>

<h2 id="retention">7. 保存期間</h2>
<ul>
  <li>{retention}</li>
  <li>データ収集の対象期間（直近60日間。設定により変わります）の投稿のうち、SNS上で削除されたものは、次回のデータ収集時に本サービスからも削除します。X の投稿は、対象期間より前のものも定期的に照会し、X 上で削除または非公開にされたことを確認した時点で削除します。</li>
  <li>クライアントとの契約が終了したときは、そのクライアントの設定・収集データ・レポート・AI分析結果をすべて削除します。</li>
  <li>データを削除したときは、そのデータを含むレポート・ダウンロード用ファイル・AI分析結果もあわせて削除します。</li>
</ul>

<h2 id="delete">8. データの削除</h2>
<ul>
  <li><strong>Facebook・Instagram：</strong>Instagram の連携は Facebook ログインを通じて行います。連携を許可した方が、Facebook の設定にある「アプリとウェブサイト」（名称は変更される場合があります）から本サービスのアプリを削除すると、Meta から削除リクエストが送信され、その方の許可により取得した Facebook・Instagram のデータを自動的に削除します。完了後、確認コード付きの確認ページ（{e(public_url)}/data-deletion/status）で状況を確認できます。</li>
  <li><strong>Threads：</strong>連携を許可した方が Threads の設定から本サービスのアプリを削除すると、同様に自動的に削除します。</li>
  <li><strong>その他：</strong>上記以外の削除のご依頼は、お問い合わせ窓口（{contact_html}）までご連絡ください。</li>
</ul>

<h2 id="security">9. 安全管理措置</h2>
<p>当社は、個人データの漏えい・滅失・毀損を防ぐため、次の措置を講じます。</p>
<ul>
  <li><strong>組織的・人的・物理的安全管理措置：</strong>{v("org_measures")}</li>
  <li><strong>技術的安全管理措置：</strong>通信の暗号化（HTTPS）、パスワードのハッシュ化、連続したログイン失敗時の一時ロック、権限の管理（すべてのクライアントを扱う当社の管理者と、割り当てられたクライアントのみを扱う一般利用者の区別）、操作記録の保存、接続情報（アクセストークン）を保存する設定ファイルへのアクセス制限</li>
  <li><strong>外的環境の把握：</strong>データは{v("server_location")}に所在するサーバーで保管します。AI分析を行う場合はアメリカ合衆国の事業者に送信するため、同国の個人情報の保護に関する制度を把握したうえで、安全管理措置を講じます。</li>
</ul>

<h2 id="cookie">10. Cookie と外部サービス</h2>
<ul>
  <li>本サービスは、ログイン状態を保つためだけに Cookie を使用します。アクセス解析や広告のための Cookie は使用しません。</li>
  <li>レポートのグラフを表示するため、プログラム（Chart.js）を外部の配信サービス（cdnjs、Cloudflare, Inc.）から読み込みます。その際、プログラムの配信のために、閲覧者のIPアドレス、ブラウザの種類、閲覧したページのURLなどが配信サービスに送信されます。</li>
</ul>

<h2 id="request">11. 開示などのご請求</h2>
<p>保有個人データの利用目的の通知、開示、訂正・追加・削除、利用停止・消去、第三者への提供の停止、第三者提供記録の開示のご請求は、お問い合わせ窓口（{contact_html}）までご連絡ください。ご本人であることを確認したうえで、法令に従い対応します。</p>
<p>保有個人データの取扱いに関する苦情・ご相談も、同じ窓口で受け付けます。</p>

<h2 id="change">12. 改定</h2>
<p>本ポリシーは、法令の改正や本サービスの内容の変更に応じて改定することがあります。重要な変更がある場合は、本サービス上でお知らせします。</p>

<p class="dates">制定日：{v("established")}{f"<br>最終改定日：{e(revised)}" if revised else ""}</p>"""


POLICY_CSS = """
.policy { max-width: 820px; }
.policy h1 { font-size: var(--fs-2xl); margin: 0 0 var(--s4); }
.policy h2 { font-size: var(--fs-lg); margin: var(--s6) 0 var(--s3); padding-top: var(--s4); border-top: 1px solid var(--border); }
.policy h3 { font-size: var(--fs-base); margin: var(--s5) 0 var(--s2); }
.policy p, .policy li { line-height: 1.8; }
.policy ul, .policy ol { padding-left: 1.4em; }
.policy li + li { margin-top: 6px; }
.policy table.kv { border: 1px solid var(--border); border-radius: var(--r-md); border-collapse: separate; border-spacing: 0;
  overflow: hidden; background: var(--surface); }
.policy table.kv th { width: 30%; min-width: 120px; background: var(--surface-2); font-size: var(--fs-md); vertical-align: top; }
.policy table.kv td { font-size: var(--fs-md); line-height: 1.8; }
.policy mark.todo { background: var(--warn-bg); color: var(--warn); font-weight: 700; padding: 0 4px; border-radius: 4px; }
.policy .dates { margin-top: var(--s6); color: var(--text-2); }
.policy nav.toc { margin: var(--s4) 0 var(--s5); }
.policy nav.toc ol { columns: 2; column-gap: var(--s6); margin: 0; }
.policy nav.toc li + li { margin-top: 0; }
.policy nav.toc a { display: inline-flex; align-items: center; min-height: 32px; }
@media (max-width: 600px) { .policy nav.toc ol { columns: 1; } .policy table.kv th { width: auto; } }
"""

TOC = [("operator", "事業者情報"), ("collect", "取得する情報"), ("purpose", "利用目的"), ("share", "第三者への提供"),
       ("ai", "AI分析のための外部送信"), ("sns", "各SNSとの関係"), ("retention", "保存期間"), ("delete", "データの削除"),
       ("security", "安全管理措置"), ("cookie", "Cookie と外部サービス"), ("request", "開示などのご請求"), ("change", "改定")]


def policy_page_body(root_cfg: dict) -> str:
    toc = "".join(f'<li><a href="#{k}">{label}</a></li>' for k, label in TOC)
    return (f'<article class="policy"><h1>プライバシーポリシー</h1>{warning_html(root_cfg)}'
            f'<nav class="toc card" aria-label="目次"><ol>{toc}</ol></nav>{render_policy(root_cfg)}</article>')


def standalone_html(root_cfg: dict) -> str:
    """別サイトに置くための単体HTML。"""
    from .ui import BASE, TOKENS
    base = str(root_cfg.get("public_url") or "").rstrip("/")
    body = policy_page_body(root_cfg).replace('href="/terms"', f'href="{base}/terms"' if base else 'href="terms.html"')
    return f"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>プライバシーポリシー</title>
<style>{TOKENS}{BASE}{POLICY_CSS} main {{ max-width: 880px; margin: 0 auto; padding: var(--s6) var(--s5) var(--s7); }}</style>
</head><body><main>{body}</main></body></html>
"""
