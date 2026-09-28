"""利用規約（本サービスの実際の機能に合わせた文面）。

事業者名などはプライバシーポリシーと同じ config.json の privacy_policy を使い、
利用規約固有の項目（管轄裁判所・制定日）は terms で設定する。未設定は【要記入】と表示する。
文面は法的助言ではない。公開前に専門家の確認を受けること。
"""
from __future__ import annotations

from html import escape as e

from .privacy import retention_days

TERMS_FIELDS = {
    ("privacy_policy", "service_name"): "サービス名",
    ("privacy_policy", "operator_name"): "事業者名",
    ("privacy_policy", "contact"): "お問い合わせ窓口",
    ("terms", "court"): "管轄裁判所",
    ("terms", "established"): "制定日",
}

TOC = [("t1", "適用"), ("t2", "定義"), ("t3", "アカウント"), ("t4", "SNSの連携"), ("t5", "AI分析"),
       ("t6", "禁止事項"), ("t7", "データの取扱い"), ("t8", "各SNSの仕様変更"), ("t9", "本サービスの変更・停止"),
       ("t10", "保証の否認"), ("t11", "責任の制限"), ("t12", "利用停止"), ("t13", "契約終了時のデータ削除"),
       ("t14", "反社会的勢力の排除"), ("t15", "本規約の変更"), ("t16", "準拠法・管轄"), ("t17", "個別契約との関係")]


def _get(root_cfg: dict, section: str, key: str) -> str:
    return str((root_cfg.get(section) or {}).get(key) or "").strip()


def missing_fields(root_cfg: dict) -> list[str]:
    return [label for (sec, key), label in TERMS_FIELDS.items() if not _get(root_cfg, sec, key)]


def warning_html(root_cfg: dict) -> str:
    missing = missing_fields(root_cfg)
    if not missing:
        return ""
    return (f'<div class="msg error" role="alert">未記入の項目があります（{e("、".join(missing))}）。'
            'config.json の privacy_policy / terms に入力し、専門家の確認を受けてから公開してください。</div>')


def render_terms(root_cfg: dict, privacy: str = "/privacy") -> str:
    def v(section: str, key: str) -> str:
        val = _get(root_cfg, section, key)
        return e(val) if val else f'<mark class="todo">【要記入：{TERMS_FIELDS[(section, key)]}】</mark>'

    contact = _get(root_cfg, "privacy_policy", "contact")
    if contact.startswith(("http://", "https://")):
        contact_html = f'<a href="{e(contact)}">{e(contact)}</a>'
    elif "@" in contact:
        contact_html = f'<a href="mailto:{e(contact)}">{e(contact)}</a>'
    else:
        contact_html = v("privacy_policy", "contact")
    operator, service = v("privacy_policy", "operator_name"), v("privacy_policy", "service_name")
    days = retention_days(root_cfg)
    revised = _get(root_cfg, "terms", "revised")

    return f"""<p>この利用規約（以下「本規約」）は、{operator}（以下「当社」）が提供するSNS分析サービス「{service}」（以下「本サービス」）の利用条件を定めるものです。本サービスを利用する方は、本規約に同意したうえで利用してください。</p>

<h2 id="t1">第1条（適用）</h2>
<ol>
  <li>本規約は、本サービスの利用に関する当社とクライアントおよび利用者との間の一切の関係に適用します。</li>
  <li>当社が本サービス上で掲載する<a href="{privacy}">プライバシーポリシー</a>その他の規定は、本規約の一部を構成します。</li>
</ol>

<h2 id="t2">第2条（定義）</h2>
<ol>
  <li>「クライアント」とは、当社と本サービスの利用に関する契約（以下「利用契約」）を締結した法人その他の団体をいいます。</li>
  <li>「利用者」とは、当社からアカウントの発行を受けた者をいいます。</li>
  <li>「管理者」とは、すべてのクライアントの情報を扱い、本サービスの全機能を利用できる権限を持つ利用者をいいます。管理者の権限は、当社の役職員その他当社が指定する者にのみ付与します。</li>
  <li>「一般利用者」とは、管理者以外の利用者をいい、割り当てられたクライアントについて、レポートの閲覧・ダウンロードと、収集済みデータからのレポートの作成のみを行えます。</li>
  <li>「連携データ」とは、クライアントの許可に基づき、各SNSの公式APIを通じて本サービスが取得した情報をいいます。</li>
</ol>

<h2 id="t3">第3条（アカウント）</h2>
<ol>
  <li>アカウントは、当社の管理者が発行します。利用者は、ログイン時にパスワードの変更を求められたときは、速やかに変更するものとします。</li>
  <li>利用者は、自己のアカウントとパスワードを適切に管理し、第三者に利用させ、貸与し、または共有してはなりません。</li>
  <li>アカウントを用いて行われた操作は、当該アカウントの利用者による操作とみなします。ただし、当社の責めに帰すべき事由による場合はこの限りではありません。</li>
  <li>パスワードの漏えいや不正利用のおそれがあるときは、利用者は直ちにパスワードを変更し、当社に連絡するものとします。</li>
</ol>

<h2 id="t4">第4条（SNSの連携）</h2>
<ol>
  <li>クライアントは、本サービスに連携するSNSアカウントについて、連携を許可する正当な権限を有していることを保証します。</li>
  <li>クライアントおよび利用者は、Instagram、Facebook、Threads、X の各利用規約・開発者向け規約・ポリシーを遵守するものとします。</li>
  <li>競合比較の対象として登録できるのは、各SNSの公式APIで公開情報として取得できるアカウントに限ります。個人を監視する目的で登録してはなりません。</li>
</ol>

<h2 id="t5">第5条（AI分析）</h2>
<ol>
  <li>本サービスのAI分析機能は、クライアントが外部事業者（Anthropic, PBC、米国）への情報の送信に同意し、その同意が本サービスに記録されている場合に限り利用できます。送信する情報と送信先での取扱いは、<a href="{privacy}#ai">プライバシーポリシー</a>に定めます。</li>
  <li>クライアントは、投稿本文を送信せず集計値のみを送信する範囲で同意することができます。同意はいつでも撤回でき、撤回した場合、当社は保存済みのAI分析結果を削除します。</li>
  <li>AI分析の結果（分析、改善提案、投稿案、目標値を含みます）は、機械的に生成された参考情報です。事実と異なる内容や不適切な表現を含む可能性があるため、利用者は内容を確認し、自らの判断と責任で利用するものとします。</li>
  <li>投稿案を実際に投稿する場合、その内容が第三者の権利を侵害していないこと、各種法令や各SNSの規約に適合していることの確認は、クライアントが行うものとします。</li>
</ol>

<h2 id="t6">第6条（禁止事項）</h2>
<p>利用者は、本サービスの利用にあたり、次の行為をしてはなりません。</p>
<ol>
  <li>法令、公序良俗または本規約に違反する行為</li>
  <li>連携する権限のないSNSアカウントを連携する行為</li>
  <li>連携データまたは分析結果を、利用契約の目的を超えて利用し、または第三者に販売・貸与する行為</li>
  <li>連携データを用いてAIモデルを学習させる行為その他、各SNSの規約で禁止される行為</li>
  <li>各SNSのAPIの利用制限を回避し、または本サービスに過度な負荷をかける行為</li>
  <li>本サービスへの不正アクセス、他の利用者のアカウントの利用、認証の回避を試みる行為</li>
  <li>本サービスの運営を妨害する行為</li>
  <li>その他、当社が不適切と合理的に判断する行為</li>
</ol>

<h2 id="t7">第7条（データの取扱い）</h2>
<ol>
  <li>連携データおよびクライアントが取り込んだデータに関する権利は、クライアントまたは正当な権利者に帰属します。当社は、本サービスの提供に必要な範囲でのみ、これらのデータを利用します。</li>
  <li>当社は、個人情報を含む情報を、<a href="{privacy}">プライバシーポリシー</a>に従って取り扱います。</li>
  <li>当社は、連携データのうち{f"投稿日または記録日から{days}日" if days else "利用契約で定める保存期間"}を過ぎたものを削除します。また、SNS上で削除された投稿は、<a href="{privacy}#retention">プライバシーポリシー</a>に定める方法により、本サービスからも削除します。</li>
</ol>

<h2 id="t8">第8条（各SNSの仕様変更）</h2>
<p>本サービスは各SNSが提供する公式APIを利用しています。各SNSによるAPIの仕様変更、提供停止、利用条件・料金の変更、審査の結果などにより、本サービスの機能の全部または一部が利用できなくなる場合があります。当社は、合理的な範囲で対応に努めますが、これにより生じた損害について責任を負いません。ただし、当社の故意または重大な過失による場合はこの限りではありません。</p>

<h2 id="t9">第9条（本サービスの変更・停止）</h2>
<ol>
  <li>当社は、本サービスの内容を変更し、または提供を終了することがあります。重要な変更や提供の終了は、事前に本サービス上またはクライアントへの連絡により通知します。</li>
  <li>当社は、設備の保守、障害、天災その他やむを得ない事由があるときは、事前の通知なく本サービスの全部または一部を一時的に停止することがあります。</li>
</ol>

<h2 id="t10">第10条（保証の否認）</h2>
<p>当社は、本サービスの分析結果およびAI分析の結果の正確性、完全性、有用性、ならびに本サービスの利用によってSNS上のフォロワー数や反応などの成果が得られることを保証しません。</p>

<h2 id="t11">第11条（責任の制限）</h2>
<p>当社が本サービスに関して責任を負う場合、その範囲は、当社の故意または重大な過失による場合を除き、クライアントに現実に生じた直接かつ通常の損害に限られ、その額は損害発生の直前12か月間にクライアントが当社に支払った本サービスの利用料金の総額を上限とします。</p>

<h2 id="t12">第12条（利用停止）</h2>
<p>当社は、利用者が本規約に違反したとき、または不正アクセスのおそれがあるときは、事前の通知なく、当該利用者のアカウントを停止し、または本サービスの利用を制限することがあります。</p>

<h2 id="t13">第13条（契約終了時のデータ削除）</h2>
<ol>
  <li>利用契約が終了したときは、当社は、当該クライアントの設定、SNSの接続情報、連携データ、レポート、AI分析の結果をすべて削除し、利用者に対する当該クライアントの割り当てを解除します。</li>
  <li>クライアントは、契約終了前に、必要なレポートやデータをダウンロード機能で保存するものとします。削除後の復元はできません。</li>
</ol>

<h2 id="t14">第14条（反社会的勢力の排除）</h2>
<p>クライアントおよび当社は、自らまたはその役員が、暴力団、暴力団員その他の反社会的勢力に該当しないこと、および反社会的勢力と関係を持たないことを表明し、保証します。相手方がこれに違反したときは、催告なく利用契約を解除することができます。</p>

<h2 id="t15">第15条（本規約の変更）</h2>
<p>当社は、民法第548条の4の定めに従い、本規約を変更することがあります。変更する場合は、変更後の内容と効力発生日を、効力発生日の相当期間前までに本サービス上で周知します。</p>

<h2 id="t16">第16条（準拠法・管轄）</h2>
<p>本規約は日本法に準拠します。本サービスに関して紛争が生じたときは、{v("terms", "court")}を第一審の専属的合意管轄裁判所とします。</p>

<h2 id="t17">第17条（個別契約との関係）</h2>
<p>当社とクライアントとの間の利用契約その他の個別の契約に本規約と異なる定めがあるときは、当該個別の契約の定めが優先します。</p>

<h2 id="contact">お問い合わせ</h2>
<p>本規約に関するお問い合わせは、{contact_html}までご連絡ください。</p>

<p class="dates">制定日：{v("terms", "established")}{f"<br>最終改定日：{e(revised)}" if revised else ""}</p>"""


def terms_page_body(root_cfg: dict, privacy: str = "/privacy") -> str:
    toc = "".join(f'<li><a href="#{k}">{label}</a></li>' for k, label in TOC)
    return (f'<article class="policy"><h1>利用規約</h1>{warning_html(root_cfg)}'
            f'<nav class="toc card" aria-label="目次"><ol>{toc}</ol></nav>{render_terms(root_cfg, privacy)}</article>')


def standalone_html(root_cfg: dict) -> str:
    from .policy import POLICY_CSS
    from .ui import BASE, TOKENS
    base = str(root_cfg.get("public_url") or "").rstrip("/")
    privacy = f"{base}/privacy" if base else "privacy.html"  # 別サイトに置くときは同じ場所の privacy.html を参照
    return f"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>利用規約</title>
<style>{TOKENS}{BASE}{POLICY_CSS} main {{ max-width: 880px; margin: 0 auto; padding: var(--s6) var(--s5) var(--s7); }}</style>
</head><body><main>{terms_page_body(root_cfg, privacy)}</main></body></html>
"""
