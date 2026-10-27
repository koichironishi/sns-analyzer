/**
 * SNSごとの投稿のきまり（文字数・画像枚数）。画面と保存時の両方で同じ判定を使う。
 */
import { PLATFORM_LABELS, type Platform } from "../models.ts";

export type Limits = { maxText: number; minImages: number; maxImages: number; maxHashtags?: number };

export const LIMITS: Record<Platform, Limits> = {
  instagram: { maxText: 2200, minImages: 1, maxImages: 10, maxHashtags: 30 },
  facebook: { maxText: 63206, minImages: 0, maxImages: 10 },
  threads: { maxText: 500, minImages: 0, maxImages: 10 },
  x: { maxText: 280, minImages: 0, maxImages: 4 },
};

const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * X の文字数（重み付き）。日本語などは1文字を2と数え、URL は長さに関係なく23と数える
 * （twitter-text の考え方に合わせた近似）。
 */
export function xLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(URL_RE, () => { n += 23; return ""; });
  for (const ch of withoutUrls) {
    const c = ch.codePointAt(0)!;
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

/** SNSごとの数え方での文字数 */
export function textLength(platform: Platform, text: string): number {
  return platform === "x" ? xLength(text) : [...text].length;
}

export const hashtagCount = (text: string) => (text.match(/[#＃][\p{L}\p{N}\p{M}_]+/gu) ?? []).length;

/** 投稿の内容が各SNSのきまりに合っているか。問題があれば理由を返す */
export function validatePost(platforms: Platform[], textOf: (p: Platform) => string, imageCount: number): string[] {
  const errors: string[] = [];
  if (!platforms.length) errors.push("投稿先のSNSを1つ以上選んでください");
  for (const p of platforms) {
    const l = LIMITS[p];
    const text = textOf(p);
    const label = PLATFORM_LABELS[p];
    if (!text.trim() && imageCount === 0) errors.push(`${label}：本文か画像のどちらかが必要です`);
    const len = textLength(p, text);
    if (len > l.maxText) errors.push(`${label}：本文が長すぎます（${len.toLocaleString()} / ${l.maxText.toLocaleString()}${p === "x" ? "。日本語は1文字を2と数えます" : "文字"}）`);
    if (imageCount < l.minImages) errors.push(`${label}：画像が${l.minImages}枚以上必要です`);
    if (imageCount > l.maxImages) errors.push(`${label}：画像は${l.maxImages}枚までです`);
    if (l.maxHashtags && hashtagCount(text) > l.maxHashtags) errors.push(`${label}：ハッシュタグは${l.maxHashtags}個までです`);
  }
  return errors;
}

/** ストーリーズを出せるSNS（Instagram・Facebook ページ） */
export const STORY_PLATFORMS: Platform[] = ["instagram", "facebook"];
export const STORY_MAX_IMAGES = 10;

/** ストーリーズの確認：出せるSNSだけ・画像が1枚以上（1枚＝1つのストーリーズ）。本文は使わない */
export function validateStory(platforms: Platform[], imageCount: number): string[] {
  const errors: string[] = [];
  if (!platforms.length) errors.push("投稿先のSNSを1つ以上選んでください");
  for (const p of platforms) if (!STORY_PLATFORMS.includes(p)) errors.push(`${PLATFORM_LABELS[p]}：ストーリーズは投稿できません（Instagram と Facebook だけです）`);
  if (imageCount < 1) errors.push("ストーリーズには画像が1枚以上必要です（1枚ごとに1つのストーリーズになります）");
  if (imageCount > STORY_MAX_IMAGES) errors.push(`ストーリーズの画像は${STORY_MAX_IMAGES}枚までです`);
  return errors;
}
