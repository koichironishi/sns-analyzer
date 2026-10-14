import type { Platform } from "../models.ts";

/**
 * 投稿の本文のリンクに、計測用の印（UTM パラメータ）を付ける。
 * Google アナリティクスなどで「どのSNSの、どの投稿から来たか」を見分けられるようにする。
 *   utm_source=instagram など / utm_medium=social / utm_campaign=sns_post / utm_content=投稿IDの先頭8文字
 * - Instagram はキャプションのリンクを押せないため付けない（長いURLで読みにくくなるだけのため）
 * - すでに utm_source が付いているリンクは、そのままにする（担当者が自分で付けた印を上書きしない）
 */
export const UTM_PLATFORMS: Platform[] = ["facebook", "threads", "x"];

// URL の終わり：空白・全角の文字・閉じかっこ類・文末の句読点
const URL_RE = /https?:\/\/[^\s　-ヿ一-鿿＀-￯<>"'）」』】]+/g;

export function addUtm(text: string, platform: Platform, postId: string): string {
  if (!UTM_PLATFORMS.includes(platform)) return text;
  return text.replace(URL_RE, (raw) => {
    // 文末の句読点や閉じかっこは URL に含めない
    const m = /^(.*?)([.,!?;:)\]]*)$/.exec(raw)!;
    const [, url, tail] = m;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return raw;
    }
    if (u.searchParams.has("utm_source")) return raw;
    u.searchParams.set("utm_source", platform);
    u.searchParams.set("utm_medium", "social");
    u.searchParams.set("utm_campaign", "sns_post");
    u.searchParams.set("utm_content", postId.slice(0, 8));
    return `${u.toString()}${tail}`;
  });
}

/** 本文にリンクがあるか（作成画面で、印を付けるかの選択を出すため） */
export const hasLink = (text: string) => /https?:\/\/\S/.test(text);
