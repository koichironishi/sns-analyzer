/**
 * 投稿先（アカウント）。同じSNSの複数アカウントに出せるよう、SNS＋アカウント（external_id）で持つ。
 *
 * 以前の投稿（targets が空）は platforms の各SNSに「そのSNSで最初に連携したアカウント」へ出し、
 * 結果（results）も以前どおり SNS 名のキーで持つ（保存済みの結果と食い違わないように）。
 */
import type { Platform } from "../models.ts";

export type Target = { platform: Platform; external_id: string };

/** 投稿先・結果のキー（"instagram:<external_id>"） */
export const targetKey = (platform: Platform, externalId: string) => `${platform}:${externalId}`;

export function parseTargetKey(key: string): Target | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const platform = key.slice(0, i) as Platform;
  const external_id = key.slice(i + 1);
  return ["instagram", "facebook", "threads", "x"].includes(platform) && external_id ? { platform, external_id } : null;
}

type ConnLike = { platform: Platform; external_id: string; connected_at?: string };
export type ResolvedTarget = { key: string; platform: Platform; externalId: string | null };

/** そのSNSで最初に連携したアカウント（以前の投稿の出し先） */
export function firstConnection<T extends ConnLike>(conns: T[], platform: Platform): T | undefined {
  return conns.filter((c) => c.platform === platform)
    .sort((a, b) => (a.connected_at ?? "").localeCompare(b.connected_at ?? "") || a.external_id.localeCompare(b.external_id))[0];
}

export function resolveTargets(post: { targets?: Target[] | null; platforms: Platform[] }, conns: ConnLike[]): ResolvedTarget[] {
  if (post.targets?.length) return post.targets.map((t) => ({ key: targetKey(t.platform, t.external_id), platform: t.platform, externalId: t.external_id }));
  return post.platforms.map((p) => ({ key: p, platform: p, externalId: firstConnection(conns, p)?.external_id ?? null }));
}

/** 選んだ投稿先から、SNS の一覧（重複なし。文字数のきまり・SNSごとの本文に使う） */
export const platformsOf = (targets: Target[]): Platform[] => [...new Set(targets.map((t) => t.platform))];
