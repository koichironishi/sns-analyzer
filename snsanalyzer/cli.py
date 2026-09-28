"""コマンドライン：python3 -m snsanalyzer [--client ID] <command>"""
from __future__ import annotations

import argparse
import getpass
import json
import logging
import os
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from . import analysis, compare, connect, export, importers, privacy, report, sample_data
from .config import (ConfigError, create_client, list_clients, load_config, save_settings)
from .db import Store
from .models import PLATFORM_LABELS, PLATFORMS, AccountSnapshot

log = logging.getLogger("snsanalyzer")


def _store(cfg: dict) -> Store:
    return Store(cfg["database"])


def _who(cfg: dict) -> str:
    return f"[{cfg['name']}] " if cfg.get("client") else ""


def _each_client(args, fn) -> int:
    """--all-clients 指定時は全クライアントに対して fn(cfg) を実行する。"""
    if getattr(args, "all_clients", False):
        root = load_config(args.config)
        clients = list_clients(root)
        if not clients:
            print("クライアントがありません。`client add <ID>` で作成してください。", file=sys.stderr)
            return 1
        codes = []
        for c in clients:
            print(f"\n=== {c} ===")
            try:
                codes.append(fn(load_config(args.config, c)))
            except (ConfigError, ValueError) as e:
                print(f"エラー：{e}", file=sys.stderr)
                codes.append(1)
        return 1 if any(codes) else 0
    return fn(load_config(args.config, args.client))


# ---- 初期化・クライアント --------------------------------------------------
def cmd_init(args) -> int:
    cfg_path = Path(args.config)
    if not cfg_path.exists():
        shutil.copy(Path(__file__).resolve().parent.parent / "config.example.json", cfg_path)
        os.chmod(cfg_path, 0o600)
        print(f"{cfg_path} を作成しました。Meta / Threads のアプリ情報を設定してください。")
    else:
        print(f"{cfg_path} は既に存在します。")
    return 0


def cmd_client_add(args) -> int:
    root = load_config(args.config)
    path = create_client(root, args.id, args.name or "", args.brand or "")
    print(f"クライアント {args.id} を作成しました：{path}")
    print(f"次に SNS を接続してください：python3 -m snsanalyzer -c {args.id} connect meta")
    return 0


def cmd_client_list(args) -> int:
    root = load_config(args.config)
    clients = list_clients(root)
    if not clients:
        print("クライアントはまだありません。`client add <ID> --name 表示名` で作成できます。")
        return 0
    print(f"{'ID':<16}{'名前':<20}接続中のSNS")
    for c in clients:
        cfg = load_config(args.config, c)
        on = [PLATFORM_LABELS[p] for p in PLATFORMS if cfg[p].get("enabled")]
        print(f"{c:<16}{cfg['name']:<20}{', '.join(on) or '（未接続）'}")
    return 0


# ---- 接続 -----------------------------------------------------------------
def _ask(prompt: str, secret: bool = False) -> str:
    if not sys.stdin.isatty():
        raise ConfigError(f"{prompt} をオプションで指定してください")
    return (getpass.getpass if secret else input)(prompt + ": ").strip()


def cmd_connect_meta(args) -> int:
    cfg = load_config(args.config, args.client)
    token = args.token
    if not token:
        print("1. 次のURLを開き、右側でアプリを選択し、以下の権限を追加して「Generate Access Token」を押します。")
        print(f"   {connect.meta_token_url(cfg)}")
        print(f"   権限：{', '.join(connect.META_SCOPES)}")
        print("2. 表示された短期アクセストークンを貼り付けてください。")
        token = _ask("短期アクセストークン", secret=True)
    long = connect.meta_exchange(cfg, token)
    pages = connect.meta_pages(cfg, long["access_token"])
    if not pages:
        raise ConfigError("管理しているFacebookページが見つかりません。権限（pages_show_list）を確認してください")
    if args.page_id:
        page = next((p for p in pages if p["page_id"] == args.page_id), None)
        if not page:
            raise ConfigError(f"ページ {args.page_id} が見つかりません")
    elif len(pages) == 1:
        page = pages[0]
    else:
        for i, p in enumerate(pages, 1):
            ig = f" / Instagram @{p['ig_username']}" if p["ig_username"] else ""
            print(f"  {i}. {p['name']}（{p['page_id']}）{ig}")
        idx = _ask("接続するページの番号")
        page = pages[int(idx) - 1]
    settings = connect.meta_settings_for_page(page, connect.meta_user_id(cfg, long["access_token"]))
    if args.only:
        settings = {k: v for k, v in settings.items() if k == args.only}
    path = save_settings(cfg, settings)
    print(f"{_who(cfg)}✓ Facebookページ「{page['name']}」を接続しました")
    if "instagram" in settings:
        print(f"{_who(cfg)}✓ Instagram @{page['ig_username']} を接続しました")
    elif not args.only:
        print("  ※ このページには Instagram ビジネスアカウントが紐づいていません")
    print(f"  保存先：{path}（ページトークンは無期限）")
    return 0


def cmd_connect_threads(args) -> int:
    cfg = load_config(args.config, args.client)
    code = args.code
    if not code:
        url, state = connect.threads_authorize_url(cfg)
        print("1. 次のURLをブラウザで開き、クライアントの Threads アカウントでログインして許可します。")
        print(f"   {url}")
        print("2. リダイレクト先のページ（表示エラーでも可）のURLをまるごと貼り付けてください。")
        code = connect.parse_code(_ask("リダイレクト先URL"), state)
    else:
        code = connect.parse_code(code)
    settings = connect.threads_exchange(cfg, code)
    path = save_settings(cfg, settings)
    t = settings["threads"]
    print(f"{_who(cfg)}✓ Threads @{t['account_name']} を接続しました（トークン期限：{t['token_expires_at'][:10]}）")
    print(f"  保存先：{path}。期限前に `refresh` で延長されます（collect 時も自動延長）。")
    return 0


def cmd_connect_x(args) -> int:
    cfg = load_config(args.config, args.client)
    bearer = args.bearer_token or _ask("Bearer Token", secret=True)
    username = args.username or _ask("X のユーザー名（@なし）")
    settings = connect.x_settings(bearer, username)
    path = save_settings(cfg, settings)
    print(f"{_who(cfg)}✓ X @{settings['x']['username']} を接続しました（保存先：{path}）")
    return 0


def cmd_disconnect(args) -> int:
    cfg = load_config(args.config, args.client)
    if args.delete_data:
        if not _confirm(f"{PLATFORM_LABELS[args.platform]} の接続を解除し、自社・競合の収集データをすべて削除します", args.yes):
            return 1
        print(_who(cfg) + privacy.delete_platform_data(cfg, args.platform, "all", disconnect=True))
        return 0
    key = {"x": "bearer_token"}.get(args.platform, "access_token")
    save_settings(cfg, {args.platform: {"enabled": False, key: "", "token_expires_at": ""}})
    print(f"{_who(cfg)}{PLATFORM_LABELS[args.platform]} の接続を解除しました（収集済みデータは残ります。"
          "削除する場合は --delete-data）")
    return 0


# ---- データ削除・同意 ----------------------------------------------------------
def _confirm(message: str, yes: bool) -> bool:
    if yes:
        return True
    if not sys.stdin.isatty():
        print(f"{message}。実行するには --yes を付けてください。", file=sys.stderr)
        return False
    ok = input(f"{message}。元に戻せません。よろしいですか？ [y/N]：").strip().lower() == "y"
    if not ok:
        print("中止しました")
    return ok


def cmd_data_delete(args) -> int:
    cfg = load_config(args.config, args.client)
    if args.competitor:
        if not _confirm(f"競合「{args.competitor}」の収集データを削除します", args.yes):
            return 1
        print(_who(cfg) + privacy.delete_competitor_data(cfg, args.competitor))
        return 0
    if not args.platform:
        raise ConfigError("--platform か --competitor を指定してください")
    target = {"own": "自社", "competitor": "競合", "all": "自社・競合"}[args.scope]
    if not _confirm(f"{PLATFORM_LABELS[args.platform]}（{target}）の収集データを削除します", args.yes):
        return 1
    print(_who(cfg) + privacy.delete_platform_data(cfg, args.platform, args.scope))
    return 0


def cmd_purge(args) -> int:
    def run(cfg):
        days = args.days if args.days is not None else privacy.retention_days(cfg)
        if days <= 0:
            print(f"{_who(cfg)}保存期間が設定されていません（config.json の retention_days）。--days で指定できます。")
            return 0
        if not args.yes and not args.all_clients and not _confirm(f"{days}日より前のデータを削除します", False):
            return 1
        print(_who(cfg) + (privacy.purge_expired(cfg, days) or ""))
        return 0
    if args.all_clients and not args.yes:
        print("--all-clients では --yes を付けて実行してください。", file=sys.stderr)
        return 1
    return _each_client(args, run)


def cmd_sync_deletions(args) -> int:
    """保存済みの X の投稿のうち、X上で削除・非公開化されたものを削除する。"""
    from .collectors.base import ApiError
    from .collectors.x import XCollector

    def run(cfg):
        if not cfg["x"].get("enabled"):
            print(f"{_who(cfg)}X が未接続のためスキップ")
            return 0
        with _store(cfg) as store:
            ids = store.post_ids("x", scope="all")
            try:
                missing = XCollector(cfg["x"]).missing_ids(ids) if ids else set()
            except (ConfigError, ApiError) as e:
                print(f"{_who(cfg)}✗ X：{e}", file=sys.stderr)
                return 1
            n = store.delete_posts("x", missing)
            if n:
                store.vacuum()
        if n:
            privacy.invalidate_reports(cfg)
        print(f"{_who(cfg)}X：保存済み {len(ids):,}件を照会し、削除・非公開化された {n}件を削除しました")
        return 0
    return _each_client(args, run)


def cmd_client_remove(args) -> int:
    root = load_config(args.config)
    if not _confirm(f"クライアント {args.id} の設定・収集データ・レポートをすべて削除します", args.yes):
        return 1
    from .auth import UserStore
    users = UserStore(root["app_db"])
    print(privacy.delete_client(root, args.id, users))
    users.log("(cli)", "", "client_deleted", args.id)
    return 0


def cmd_consent_show(args) -> int:
    cfg = load_config(args.config, args.client)
    c = privacy.get_consent(cfg)
    label = {"granted": "同意済み", "revoked": "撤回済み", "unset": "未登録"}.get(c["status"], c["status"])
    if c["outdated"]:
        label += "（説明内容の更新により再同意が必要）"
    print(f"{_who(cfg)}AI分析の同意：{label}")
    if c["status"] == "granted":
        print(f"  同意者：{c.get('granted_by')}　日時：{c.get('granted_at', '')[:16].replace('T', ' ')}（UTC）"
              f"　投稿本文の送信：{'あり' if c.get('include_post_text') else 'なし（集計値のみ）'}")
    print("\n説明文（同意を得る際に提示する内容）：")
    for line in privacy.consent_text(c.get("include_post_text", True)):
        print(f"  ・{line}")
    return 0


def cmd_consent_grant(args) -> int:
    cfg = load_config(args.config, args.client)
    c = privacy.grant_consent(cfg, args.by, include_post_text=not args.no_post_text, note=args.note or "",
                              recorded_by=os.environ.get("USER", ""))
    print(f"{_who(cfg)}AI分析の同意を記録しました（同意者：{c['granted_by']}、投稿本文："
          f"{'送信する' if c['include_post_text'] else '送信しない'}）")
    return 0


def cmd_consent_revoke(args) -> int:
    cfg = load_config(args.config, args.client)
    n = privacy.revoke_consent(cfg, recorded_by=os.environ.get("USER", ""))
    print(f"{_who(cfg)}AI分析の同意を撤回しました。AI分析結果を含むファイル {n}件を削除しました。"
          "レポートは report で作り直せます（AI分析なし）。")
    return 0


def cmd_status(args) -> int:
    def run(cfg):
        bad = 0
        print(f"{_who(cfg) or '[既定] '}接続状況")
        for p in PLATFORMS:
            r = connect.check(p, cfg)
            if not r["enabled"]:
                print(f"  -  {PLATFORM_LABELS[p]:<10} 未接続")
                continue
            mark = "✓" if r["ok"] else "✗"
            bad += not r["ok"]
            fol = f"フォロワー {r['followers']:,}" if r["followers"] is not None else ""
            acct = f"@{r['account']}" if r["account"] else ""
            print(f"  {mark}  {PLATFORM_LABELS[p]:<10} {acct} {fol}  {r['message']}")
        return 1 if bad else 0
    return _each_client(args, run)


def _refresh(cfg: dict, force: bool = False) -> None:
    if not cfg["threads"].get("enabled"):
        return
    if force or connect.needs_refresh(cfg):
        settings = connect.threads_refresh(cfg)
        save_settings(cfg, settings)
        print(f"{_who(cfg)}Threads のトークンを延長しました（期限：{settings['threads']['token_expires_at'][:10]}）")


def cmd_refresh(args) -> int:
    from .collectors.base import ApiError

    def run(cfg):
        try:
            _refresh(cfg, force=True)
        except ApiError as e:
            print(f"✗ Threads トークンの延長に失敗：{e}", file=sys.stderr)
            return 1
        return 0
    return _each_client(args, run)


# ---- ユーザーアカウント（Webダッシュボード） ----------------------------------
def _users(args):
    from .auth import UserStore
    return UserStore(load_config(args.config)["app_db"])


def _new_password(args, username: str) -> str:
    if args.password_stdin:
        return sys.stdin.readline().rstrip("\n")
    if not sys.stdin.isatty():
        raise ConfigError("パスワードは対話入力するか --password-stdin で渡してください")
    p1 = getpass.getpass(f"{username} のパスワード（10文字以上）：")
    if p1 != getpass.getpass("もう一度入力："):
        raise ConfigError("パスワードが一致しません")
    return p1


def cmd_user_add(args) -> int:
    from .auth import AuthError
    root = load_config(args.config)
    unknown = [c for c in (args.client_ids or []) if c not in list_clients(root)]
    if unknown:
        raise ConfigError(f"存在しないクライアント：{', '.join(unknown)}")
    users = _users(args)
    try:
        u = users.create(args.username, _new_password(args, args.username), args.role, args.name or "",
                         args.client_ids or [], must_change=args.must_change)
    except AuthError as e:
        raise ConfigError(str(e)) from None
    users.log("(cli)", "", "user_created", f"{u.username} ({u.role})")
    if u.is_admin:
        print("⚠ 管理者はすべてのクライアントの情報を閲覧・操作できます。クライアント企業の方には付与しないでください。")
    scope = "すべてのクライアント" if u.is_admin else (", ".join(u.clients) or "担当クライアントなし")
    print(f"{'管理者' if u.is_admin else 'ユーザー'} {u.username} を作成しました（{scope}）")
    return 0


def cmd_user_list(args) -> int:
    users = _users(args).list()
    if not users:
        print("ユーザーはいません。`user add <名前> --role admin` で管理者を作成してください。")
        return 0
    print(f"{'ユーザー名':<20}{'権限':<8}{'状態':<6}{'最終ログイン':<18}担当クライアント")
    for u in users:
        print(f"{u.username:<20}{'管理者' if u.is_admin else 'ユーザー':<8}{'有効' if u.active else '無効':<6}"
              f"{(u.last_login or '—')[:16].replace('T', ' '):<18}{'すべて' if u.is_admin else ', '.join(u.clients) or '—'}")
    return 0


def _find_user(args):
    users = _users(args)
    u = users.get(args.username)
    if not u:
        raise ConfigError(f"ユーザー {args.username} は存在しません")
    return users, u


def cmd_user_passwd(args) -> int:
    from .auth import AuthError
    users, u = _find_user(args)
    try:
        users.set_password(u.id, _new_password(args, u.username), must_change=args.must_change)
    except AuthError as e:
        raise ConfigError(str(e)) from None
    users.log("(cli)", "", "password_reset", u.username)
    print(f"{u.username} のパスワードを変更しました（ログイン中のセッションは無効化）")
    return 0


def cmd_user_set(args) -> int:
    from .auth import AuthError
    users, u = _find_user(args)
    clients = None
    if args.client_ids is not None:
        unknown = [c for c in args.client_ids if c not in list_clients(load_config(args.config))]
        if unknown:
            raise ConfigError(f"存在しないクライアント：{', '.join(unknown)}")
        clients = args.client_ids
    active = {"enable": True, "disable": False}.get(args.state) if args.state else None
    try:
        u = users.update(u.id, role=args.role, display_name=args.name, clients=clients, active=active)
    except AuthError as e:
        raise ConfigError(str(e)) from None
    users.log("(cli)", "", "user_updated", u.username)
    print(f"{u.username}: {'管理者' if u.is_admin else 'ユーザー'} / {'有効' if u.active else '無効'} / "
          f"{'すべて' if u.is_admin else ', '.join(u.clients) or '担当なし'}")
    return 0


def cmd_user_remove(args) -> int:
    from .auth import AuthError
    users, u = _find_user(args)
    if not args.yes:
        if not sys.stdin.isatty() or input(f"{u.username} を削除します。よろしいですか？ [y/N]: ").lower() != "y":
            print("中止しました")
            return 1
    try:
        users.delete(u.id)
    except AuthError as e:
        raise ConfigError(str(e)) from None
    users.log("(cli)", "", "user_deleted", u.username)
    print(f"{u.username} を削除しました")
    return 0


def cmd_privacy_policy(args) -> int:
    from . import policy
    root = load_config(args.config)
    missing = policy.missing_fields(root)
    if missing:
        print(f"⚠ 未記入の項目があります：{'、'.join(missing)}（config.json の privacy_policy に入力してください）",
              file=sys.stderr)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(policy.standalone_html(root), encoding="utf-8")
    print(f"プライバシーポリシーを出力しました：{out.resolve()}")
    print("Webダッシュボードでは /privacy で公開されます。公開前に専門家の確認を受けてください。")
    return 0


def cmd_terms(args) -> int:
    from . import terms
    root = load_config(args.config)
    missing = terms.missing_fields(root)
    if missing:
        print(f"⚠ 未記入の項目があります：{'、'.join(missing)}（config.json の privacy_policy / terms）", file=sys.stderr)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(terms.standalone_html(root), encoding="utf-8")
    print(f"利用規約を出力しました：{out.resolve()}")
    print("Webダッシュボードでは /terms で公開されます。公開前に専門家の確認を受けてください。")
    return 0


def cmd_serve(args) -> int:
    from .web import serve
    serve(args.config, args.host, args.port, args.secure_cookies, args.trust_proxy)
    return 0


# ---- 競合 -----------------------------------------------------------------
def _competitors(cfg: dict) -> list[dict]:
    return list(cfg.get("competitors") or [])


def cmd_competitor_add(args) -> int:
    cfg = load_config(args.config, args.client)
    handles = {p: getattr(args, p) for p in PLATFORMS if getattr(args, p)}
    if not handles:
        raise ConfigError("--instagram / --facebook / --threads / --x のいずれかを指定してください")
    comps = _competitors(cfg)
    entry = next((c for c in comps if c["name"] == args.name), None)
    if entry is None:
        entry = {"name": args.name}
        comps.append(entry)
    entry.update({p: h.lstrip("@") for p, h in handles.items()})
    save_settings(cfg, {"competitors": comps})
    print(f"{_who(cfg)}競合「{args.name}」を登録しました："
          + ", ".join(f"{PLATFORM_LABELS[p]} {h}" for p, h in handles.items()))
    print("  次回の collect から競合データも取得します。")
    return 0


def cmd_competitor_list(args) -> int:
    cfg = load_config(args.config, args.client)
    comps = _competitors(cfg)
    if not comps:
        print(f"{_who(cfg)}競合は未登録です。`competitor add 名前 --instagram ユーザー名` で追加できます。")
        return 0
    for c in comps:
        accts = ", ".join(f"{PLATFORM_LABELS[p]} {c[p]}" for p in PLATFORMS if c.get(p))
        print(f"  {c['name']}: {accts}")
    return 0


def cmd_competitor_remove(args) -> int:
    cfg = load_config(args.config, args.client)
    comps = [c for c in _competitors(cfg) if c["name"] != args.name]
    if len(comps) == len(_competitors(cfg)):
        raise ConfigError(f"競合「{args.name}」は登録されていません")
    save_settings(cfg, {"competitors": comps})
    print(f"{_who(cfg)}競合「{args.name}」を比較対象から外しました（収集済みデータは残ります）")
    return 0


def _collect_competitors(cfg: dict, store: Store, since: datetime) -> int:
    """登録済み競合の公開データを、自社の接続情報を使って取得する。"""
    from .collectors import COLLECTORS
    from .collectors.base import ApiError

    failed = 0
    for comp in _competitors(cfg):
        for p in PLATFORMS:
            handle = comp.get(p)
            if not handle:
                continue
            label = f"{_who(cfg)}  競合 {comp['name']} / {PLATFORM_LABELS[p]}"
            if not cfg[p].get("enabled"):
                print(f"{label}: 自社の {PLATFORM_LABELS[p]} が未接続のためスキップ")
                continue
            try:
                collector = COLLECTORS[p](cfg[p], cfg["graph_api_version"])
                result = collector.collect_competitor(handle, since, cfg.get("max_competitor_posts", 100))
            except (ConfigError, ApiError) as e:
                print(f"{label}: ✗ {e}", file=sys.stderr)
                failed += 1
                continue
            store.save_snapshot(result.account)
            store.mark_competitor(p, result.account.account_id, comp["name"])
            n = store.save_posts(result.posts, date.today())
            if result.posts and len(result.posts) < cfg.get("max_competitor_posts", 100):
                store.reconcile(p, result.account.account_id, since, {x.post_id for x in result.posts})
            note = f"、投稿 {n} 件" if result.posts else "（フォロワー数のみ）"
            print(f"{label}: ✓ フォロワー {result.account.followers or '—'}{note}")
    return failed


# ---- 収集・取り込み --------------------------------------------------------
def cmd_collect(args) -> int:
    from .collectors import COLLECTORS
    from .collectors.base import ApiError

    def run(cfg):
        targets = args.platform or [p for p in PLATFORMS if cfg[p].get("enabled")]
        if not targets:
            print(f"{_who(cfg)}接続中のSNSがありません。connect で接続してください。", file=sys.stderr)
            return 1
        try:
            _refresh(cfg)
        except ApiError as e:
            print(f"{_who(cfg)}Threads トークンの自動延長に失敗：{e}", file=sys.stderr)
        since = datetime.now(timezone.utc) - timedelta(days=args.days)
        failed = 0
        with _store(cfg) as store:
            for p in targets:
                try:
                    collector = COLLECTORS[p](cfg[p], cfg["graph_api_version"])
                    result = collector.collect(since, cfg["max_posts_per_run"])
                except (ConfigError, ApiError) as e:
                    print(f"{_who(cfg)}✗ {PLATFORM_LABELS[p]}：{e}", file=sys.stderr)
                    failed += 1
                    continue
                store.save_snapshot(result.account)
                n = store.save_posts(result.posts, date.today())
                gone = 0
                if len(result.posts) < cfg["max_posts_per_run"]:  # 期間内を取り切れたときだけ照合する
                    gone = store.reconcile(p, result.account.account_id, since, {x.post_id for x in result.posts})
                print(f"{_who(cfg)}✓ {PLATFORM_LABELS[p]} @{result.account.username}："
                      f"フォロワー {result.account.followers or '—'}、投稿 {n} 件"
                      + (f"（SNS上で削除された投稿 {gone} 件を削除）" if gone else ""))
            if _competitors(cfg) and not args.no_competitors:
                _collect_competitors(cfg, store, since)
        msg = privacy.purge_expired(cfg)
        if msg:
            print(f"{_who(cfg)}保存期間（{privacy.retention_days(cfg)}日）：{msg}")
        return 1 if failed and failed == len(targets) else 0
    return _each_client(args, run)


def _account_id(args) -> str:
    if args.competitor:  # 競合はAPIで取得したアカウントとは別IDで持つ（手動分）
        return f"manual_{args.competitor}_{args.platform}"
    return args.account or f"csv_{args.platform}"


def cmd_import(args) -> int:
    cfg = load_config(args.config, args.client)
    tz = ZoneInfo(cfg["timezone"])
    account_id = _account_id(args)
    posts = importers.read_csv(args.file, args.platform, account_id, tz)
    with _store(cfg) as store:
        store.save_snapshot(AccountSnapshot(args.platform, account_id, args.account or account_id,
                                            date.today(), followers=args.followers))
        if args.competitor:
            store.mark_competitor(args.platform, account_id, args.competitor)
        n = store.save_posts(posts, date.today())
    who = f"競合 {args.competitor} / " if args.competitor else ""
    print(f"{_who(cfg)}{who}{PLATFORM_LABELS[args.platform]}: {n} 件を取り込みました。")
    return 0


def cmd_followers(args) -> int:
    cfg = load_config(args.config, args.client)
    d = date.fromisoformat(args.date) if args.date else date.today()
    account_id = _account_id(args)
    with _store(cfg) as store:
        store.save_snapshot(AccountSnapshot(args.platform, account_id, args.account or account_id,
                                            d, followers=args.count))
        if args.competitor:
            store.mark_competitor(args.platform, account_id, args.competitor)
    print(f"{_who(cfg)}{PLATFORM_LABELS[args.platform]} {d}: フォロワー {args.count:,} を記録しました。")
    return 0


# ---- 分析・レポート --------------------------------------------------------
def _ai_cache_path(cfg: dict, data: dict) -> Path:
    per = data["period"]
    return Path(cfg["report_dir"]) / f"ai_{per['end']}_{per['days']}d.json"


def build(cfg: dict, days: int, *, ai: bool = False, question: str = "",
          db_path: str | None = None) -> dict:
    """分析 → （必要なら）AI分析 → ダウンロード用ファイル作成までを行い data を返す。"""
    tz = ZoneInfo(cfg["timezone"])
    with Store(db_path or cfg["database"]) as store:
        posts = store.load_posts()
        followers = store.load_follower_series()
        data = analysis.analyze(posts, followers, tz, days=days, account_names=store.account_names())
        comp_map = store.competitor_map()
        if comp_map:
            names = [c["name"] for c in _competitors(cfg)] if cfg.get("competitors") is not None else None
            data["competitors"] = compare.compare(
                posts, followers, store.load_posts(scope="competitor"), store.account_follower_series(),
                comp_map, store.usernames(), store.account_names(), tz, days=days,
                end=date.fromisoformat(data["period"]["end"]), competitors=names)
    data["client_id"] = cfg.get("client") or ""
    data["client_name"] = cfg.get("name") or ""
    cache = _ai_cache_path(cfg, data)
    demo = bool(cfg.get("_demo"))  # サンプルデータのデモは実データを送らないため同意不要
    if ai and data["platforms"]:
        from .ai import run_ai_analysis
        consent = None if demo else privacy.require_consent(cfg)
        print(f"{_who(cfg)}Claude で分析しています（1〜数分かかります）…", flush=True)
        data["ai"] = run_ai_analysis(data, posts, followers, tz, cfg.get("ai"), question, consent)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(data["ai"], ensure_ascii=False, indent=1), encoding="utf-8")
        m = data["ai"]["_meta"]
        print(f"{_who(cfg)}AI分析完了（入力 {m['input_tokens']:,} / 出力 {m['output_tokens']:,} トークン）")
    elif cache.exists() and (demo or privacy.get_consent(cfg)["valid"]):  # 同じ期間の結果を再利用
        data["ai"] = json.loads(cache.read_text(encoding="utf-8"))
    data["downloads"] = export.downloads(data, posts, followers, tz)
    return data


def _write(cfg: dict, data: dict, out: str | None, zip_: bool) -> Path:
    per = data["period"]
    base = Path(cfg["report_dir"]) / f"report_{per['end']}_{per['days']}d"
    path = report.write_report(data, out or base.with_suffix(".html"))
    latest = Path(cfg["report_dir"]) / "latest.html"
    if path.resolve() != latest.resolve():
        shutil.copyfile(path, latest)
    print(f"{_who(cfg)}レポート：{path.resolve()}")
    if zip_:
        z = export.write_bundle(base.with_suffix(".zip"), path.read_text(encoding="utf-8"),
                                data, data["downloads"])
        print(f"{_who(cfg)}ダウンロード用ZIP: {z.resolve()}")
    return path


def cmd_report(args) -> int:
    overview = []

    def run(cfg):
        data = build(cfg, args.days, ai=args.ai, question=args.question or "")
        if not data["platforms"]:
            print(f"{_who(cfg)}データがありません。collect か import-csv を先に実行してください。",
                  file=sys.stderr)
            overview.append({"id": cfg["client"], "name": cfg["name"], "data": None,
                             "note": "データなし"})
            return 0 if args.all_clients else 1
        path = _write(cfg, data, None if args.all_clients else args.out, args.zip)
        overview.append({"id": cfg["client"], "name": cfg["name"], "data": data, "path": path})
        if not args.all_clients:
            _print_summary(data)
        return 0

    code = _each_client(args, run)
    if args.all_clients and overview:
        root = load_config(args.config)
        index = Path(root["clients_dir"]) / "index.html"
        for e in overview:
            if e.get("path"):
                e["report"] = os.path.relpath(e["path"], index.parent)
        tz = ZoneInfo(root["timezone"])
        index.write_text(report.render_overview(overview, datetime.now(tz).strftime("%Y-%m-%d %H:%M")),
                         encoding="utf-8")
        print(f"\nクライアント一覧：{index.resolve()}")
    return code


def cmd_ai(args) -> int:
    from .ai import format_text

    cfg = load_config(args.config, args.client)
    data = build(cfg, args.days, ai=True, question=args.question or "")
    if not data["platforms"]:
        print("データがありません。", file=sys.stderr)
        return 1
    print()
    print(format_text(data["ai"]))
    print()
    _write(cfg, data, None, args.zip)
    return 0


def cmd_export(args) -> int:
    def run(cfg):
        data = build(cfg, args.days)
        if not data["platforms"]:
            print(f"{_who(cfg)}データがありません。", file=sys.stderr)
            return 1
        _write(cfg, data, None, zip_=True)
        return 0
    return _each_client(args, run)


def cmd_summary(args) -> int:
    cfg = load_config(args.config, args.client)
    _print_summary(build(cfg, args.days))
    return 0


def _print_summary(d: dict) -> None:
    per = d["period"]
    print(f"\n■ {per['start'].replace('-', '/')}〜{per['end'].replace('-', '/')}（{per['days']}日間）")
    for p in d["platforms"]:
        s = d["summary"][p]
        er = f"{s['er_followers'] * 100:.2f}%" if s["er_followers"] is not None else "—"
        fol = f"{s['followers']:,}" if s["followers"] is not None else "—"
        print(f"  {s['label']:<10} フォロワー {fol:>8}  投稿 {s['posts']:>3}  "
              f"反応 {s['engagements']:>8,}  ER {er}")
    if d["insights"]:
        print("\n■ ポイント")
        for i in d["insights"]:
            print(f"  - {i['text']}")
    comp = d.get("competitors")
    if comp and comp["insights"]:
        print("\n■ 競合比較")
        for i in comp["insights"]:
            print(f"  - {i['text']}")


def cmd_demo(args) -> int:
    cfg = load_config(args.config)
    db_path = Path(cfg["database"]).parent / "demo.db"
    if db_path.exists():
        db_path.unlink()
    with Store(db_path) as store:
        n = sample_data.generate(store, tz_name=cfg["timezone"])
    cfg = {**cfg, "report_dir": str(Path(cfg["report_dir"]) / "demo"), "name": "デモ株式会社", "_demo": True,
           "client": "demo", "ai": {**cfg["ai"], "brand_context":
               "Webサイト・ブランディング・採用広報を手がける制作会社（デモ）。目的は問い合わせ獲得と採用。"}}
    data = build(cfg, args.days, ai=args.ai, question=args.question or "", db_path=str(db_path))
    print(f"デモデータ {n} 件を生成しました。")
    _write(cfg, data, None, args.zip)
    _print_summary(data)
    return 0


# ---- パーサー ---------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="snsanalyzer",
                                 description="Instagram / Facebook / Threads / X の分析ツール")
    ap.add_argument("--config", default="config.json", help="共通設定ファイル（既定：config.json）")
    ap.add_argument("-c", "--client", default=os.environ.get("SNS_CLIENT"),
                    help="対象クライアントID（環境変数 SNS_CLIENT でも指定可）")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="共通設定ファイルを作成").set_defaults(func=cmd_init)

    cl = sub.add_parser("client", help="クライアント管理").add_subparsers(dest="client_cmd", required=True)
    a = cl.add_parser("add", help="クライアントを追加")
    a.add_argument("id", help="英数字のID（例：acme）")
    a.add_argument("--name", help="表示名（例：株式会社ACME）")
    a.add_argument("--brand", help="事業内容・SNSの目的など（AI分析の前提として使用）")
    a.set_defaults(func=cmd_client_add)
    cl.add_parser("list", help="クライアント一覧").set_defaults(func=cmd_client_list)
    cr_ = cl.add_parser("remove", help="クライアントの設定・データ・レポートをすべて削除")
    cr_.add_argument("id")
    cr_.add_argument("--yes", action="store_true", help="確認を省略")
    cr_.set_defaults(func=cmd_client_remove)

    cs = sub.add_parser("consent", help="AI分析（Anthropicへの送信）の同意管理").add_subparsers(
        dest="consent_cmd", required=True)
    cs.add_parser("show", help="同意の状況と説明文を表示").set_defaults(func=cmd_consent_show)
    cg = cs.add_parser("grant", help="クライアントの同意を記録")
    cg.add_argument("--by", required=True, help="同意した方の氏名・所属（例: 山田（ACME広報部））")
    cg.add_argument("--no-post-text", action="store_true", help="投稿本文は送らず、集計値のみ送る")
    cg.add_argument("--note", help="メモ（同意の取得方法など）")
    cg.set_defaults(func=cmd_consent_grant)
    cs.add_parser("revoke", help="同意を撤回し、AI分析結果を削除").set_defaults(func=cmd_consent_revoke)

    dt = sub.add_parser("data", help="収集データの削除").add_subparsers(dest="data_cmd", required=True)
    dd = dt.add_parser("delete", help="SNS別・競合別にデータを削除")
    dd.add_argument("--platform", choices=PLATFORMS)
    dd.add_argument("--scope", choices=["own", "competitor", "all"], default="own",
                    help="own=自社（既定） / competitor=競合 / all=両方")
    dd.add_argument("--competitor", help="この競合のデータだけ削除")
    dd.add_argument("--yes", action="store_true", help="確認を省略")
    dd.set_defaults(func=cmd_data_delete)

    pg = sub.add_parser("purge", help="保存期間を過ぎたデータを削除（collect 時にも自動実行）")
    pg.add_argument("--days", type=int, help="この日数より前のデータを削除（既定: retention_days）")
    pg.add_argument("--all-clients", action="store_true")
    pg.add_argument("--yes", action="store_true", help="確認を省略")
    pg.set_defaults(func=cmd_purge)

    sd = sub.add_parser("sync-deletions", help="X上で削除・非公開化された投稿を保存データから削除（X APIを消費）")
    sd.add_argument("--all-clients", action="store_true")
    sd.set_defaults(func=cmd_sync_deletions)

    cn = sub.add_parser("connect", help="SNSと接続する").add_subparsers(dest="connect_cmd", required=True)
    m = cn.add_parser("meta", help="Facebook ページ＋Instagram を接続")
    m.add_argument("--token", help="短期ユーザーアクセストークン（省略時は対話入力）")
    m.add_argument("--page-id", help="接続するページID（複数ページがある場合）")
    m.add_argument("--only", choices=["facebook", "instagram"], help="片方だけ接続する")
    m.set_defaults(func=cmd_connect_meta)
    t = cn.add_parser("threads", help="Threads を接続（OAuth）")
    t.add_argument("--code", help="認可コード、またはリダイレクト先URL（省略時は対話入力）")
    t.set_defaults(func=cmd_connect_threads)
    x = cn.add_parser("x", help="X を接続（Bearer Token）")
    x.add_argument("--bearer-token")
    x.add_argument("--username")
    x.set_defaults(func=cmd_connect_x)

    us = sub.add_parser("user", help="ログインユーザー管理（Webダッシュボード）").add_subparsers(
        dest="user_cmd", required=True)
    ua = us.add_parser("add", help="ユーザーを作成")
    ua.add_argument("username")
    ua.add_argument("--role", choices=["admin", "user"], default="user",
                    help="admin=全操作 / user=担当クライアントの閲覧のみ（既定）")
    ua.add_argument("--client", dest="client_ids", action="append", help="担当クライアントID（複数可）")
    ua.add_argument("--name", help="表示名")
    ua.add_argument("--must-change", action="store_true", help="初回ログイン時にパスワード変更を求める")
    ua.add_argument("--password-stdin", action="store_true", help="パスワードを標準入力から読む")
    ua.set_defaults(func=cmd_user_add)
    us.add_parser("list", help="ユーザー一覧").set_defaults(func=cmd_user_list)
    up = us.add_parser("passwd", help="パスワードを変更")
    up.add_argument("username")
    up.add_argument("--must-change", action="store_true")
    up.add_argument("--password-stdin", action="store_true")
    up.set_defaults(func=cmd_user_passwd)
    uset = us.add_parser("set", help="権限・担当クライアント・有効/無効を変更")
    uset.add_argument("username")
    uset.add_argument("--role", choices=["admin", "user"])
    uset.add_argument("--client", dest="client_ids", action="append",
                      help="担当クライアント（指定したもので置き換え）")
    uset.add_argument("--name")
    uset.add_argument("--state", choices=["enable", "disable"])
    uset.set_defaults(func=cmd_user_set)
    ur = us.add_parser("remove", help="ユーザーを削除")
    ur.add_argument("username")
    ur.add_argument("--yes", action="store_true", help="確認を省略")
    ur.set_defaults(func=cmd_user_remove)

    pp = sub.add_parser("privacy-policy", help="プライバシーポリシーをHTMLで出力（Webでは /privacy）")
    pp.add_argument("--out", default="reports/privacy.html", help="出力先（既定: reports/privacy.html）")
    pp.set_defaults(func=cmd_privacy_policy)

    tm = sub.add_parser("terms", help="利用規約をHTMLで出力（Webでは /terms）")
    tm.add_argument("--out", default="reports/terms.html", help="出力先（既定: reports/terms.html）")
    tm.set_defaults(func=cmd_terms)

    sv = sub.add_parser("serve", help="ログイン付きWebダッシュボードを起動")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)
    sv.add_argument("--secure-cookies", action="store_true", help="HTTPS運用時に指定（Secure Cookie・HSTS）")
    sv.add_argument("--trust-proxy", action="store_true",
                    help="リバースプロキシの X-Forwarded-For を接続元IPとして使う（プロキシ背後でのみ指定）")
    sv.set_defaults(func=cmd_serve)

    cp = sub.add_parser("competitor", help="競合アカウント管理").add_subparsers(dest="comp_cmd", required=True)
    ca = cp.add_parser("add", help="競合を登録（同じ名前なら追記）")
    ca.add_argument("name", help="競合の表示名（例：競合A社）")
    ca.add_argument("--instagram", help="Instagram ユーザー名（ビジネス／クリエイターアカウント）")
    ca.add_argument("--facebook", help="Facebook ページID またはユーザー名")
    ca.add_argument("--threads", help="Threads ユーザー名")
    ca.add_argument("--x", help="X ユーザー名")
    ca.set_defaults(func=cmd_competitor_add)
    cp.add_parser("list", help="登録済みの競合").set_defaults(func=cmd_competitor_list)
    cr = cp.add_parser("remove", help="競合を比較対象から外す")
    cr.add_argument("name")
    cr.set_defaults(func=cmd_competitor_remove)

    d = sub.add_parser("disconnect", help="SNSの接続を解除")
    d.add_argument("platform", choices=PLATFORMS)
    d.add_argument("--delete-data", action="store_true", help="収集済みデータ（自社・競合）も削除する")
    d.add_argument("--yes", action="store_true", help="確認を省略")
    d.set_defaults(func=cmd_disconnect)

    for name, func, help_ in (("status", cmd_status, "接続状況とトークン期限を確認"),
                              ("refresh", cmd_refresh, "Threads のトークンを延長")):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--all-clients", action="store_true", help="全クライアントに実行")
        s.set_defaults(func=func)

    c = sub.add_parser("collect", help="APIから投稿と指標を取得して保存")
    c.add_argument("--platform", action="append", choices=PLATFORMS, help="対象SNS（複数可）")
    c.add_argument("--days", type=int, default=60, help="何日前までの投稿を取得するか（既定：60）")
    c.add_argument("--all-clients", action="store_true", help="全クライアントを収集")
    c.add_argument("--no-competitors", action="store_true", help="競合の取得をしない")
    c.set_defaults(func=cmd_collect)

    i = sub.add_parser("import-csv", help="CSV（エクスポートデータ等）を取り込む")
    i.add_argument("file")
    i.add_argument("--platform", required=True, choices=PLATFORMS)
    i.add_argument("--account", help="アカウント名（任意）")
    i.add_argument("--followers", type=int, help="現在のフォロワー数（任意）")
    i.add_argument("--competitor", help="競合のデータとして取り込む（競合名）")
    i.set_defaults(func=cmd_import)

    f = sub.add_parser("followers", help="フォロワー数を手動で記録する")
    f.add_argument("--platform", required=True, choices=PLATFORMS)
    f.add_argument("--count", type=int, required=True)
    f.add_argument("--date", help="YYYY-MM-DD（既定：今日）")
    f.add_argument("--account")
    f.add_argument("--competitor", help="競合のフォロワー数として記録（競合名）")
    f.set_defaults(func=cmd_followers)

    r = sub.add_parser("report", help="HTMLレポートを出力")
    r.add_argument("--days", type=int, default=30, help="分析期間の日数（既定：30）")
    r.add_argument("--out", help="出力先HTMLファイル")
    r.add_argument("--ai", action="store_true", help="Claude による AI分析を含める")
    r.add_argument("--question", help="AIに聞きたいこと（--ai と併用）")
    r.add_argument("--zip", action="store_true", help="CSV等を同梱したZIPも出力")
    r.add_argument("--all-clients", action="store_true", help="全クライアント分を出力し一覧ページも作成")
    r.set_defaults(func=cmd_report)

    ai = sub.add_parser("ai", help="Claude で AI分析（結果を表示しレポートにも反映）")
    ai.add_argument("--days", type=int, default=30)
    ai.add_argument("--question", help="AIに聞きたいこと（例：リールを増やすべき？）")
    ai.add_argument("--zip", action="store_true")
    ai.set_defaults(func=cmd_ai)

    e = sub.add_parser("export", help="レポート・CSV・AI分析をZIPにまとめて出力")
    e.add_argument("--days", type=int, default=30)
    e.add_argument("--all-clients", action="store_true")
    e.set_defaults(func=cmd_export)

    s = sub.add_parser("summary", help="ターミナルに要約を表示")
    s.add_argument("--days", type=int, default=30)
    s.set_defaults(func=cmd_summary)

    dm = sub.add_parser("demo", help="サンプルデータでデモレポートを作成")
    dm.add_argument("--days", type=int, default=30)
    dm.add_argument("--ai", action="store_true", help="AI分析も実行（APIキーが必要）")
    dm.add_argument("--question")
    dm.add_argument("--zip", action="store_true")
    dm.set_defaults(func=cmd_demo)
    return ap


def main(argv=None) -> int:
    from .collectors.base import ApiError

    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s %(message)s")
    try:
        return args.func(args)
    except ApiError as e:
        print(f"APIエラー：{e}", file=sys.stderr)
    except (ConfigError, ValueError, FileNotFoundError, KeyboardInterrupt) as e:
        print(f"エラー：{e}", file=sys.stderr)
    except Exception as e:  # AI分析のエラー等
        if type(e).__name__ == "AIError":
            print(f"AI分析エラー：{e}", file=sys.stderr)
        else:
            raise
    return 1
