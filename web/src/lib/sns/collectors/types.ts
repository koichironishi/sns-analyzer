import type { Platform } from "../models.ts";
import type { CollectResult, HttpOptions } from "./http.ts";

/** sns_connections の1行から作る接続情報（トークンはサーバー内でのみ扱う） */
export type ConnectionConfig = {
  platform: Platform;
  externalId: string; // IG ユーザーID／FB ページID／Threads ユーザーID／X ユーザーID
  username: string;
  accessToken: string; // X は Bearer Token
};

export type CollectOptions = {
  since: string; // ISO（UTC）。これより新しい投稿を取得
  maxPosts: number;
  /** この時刻（ms）を過ぎたら取得を打ち切る（サーバーレスの実行時間対策） */
  deadline?: number;
};

export interface Collector {
  collect(opts: CollectOptions): Promise<CollectResult>;
  /** 自社の接続情報を使って、競合の公開データを取得する */
  collectCompetitor(handle: string, opts: CollectOptions): Promise<CollectResult>;
}

export type CollectorDeps = { graphVersion?: string; http?: HttpOptions };

export const overDeadline = (opts: CollectOptions) => opts.deadline !== undefined && Date.now() > opts.deadline;
export const DEADLINE_WARNING = "時間内に取得しきれなかった投稿があります。次回の収集で続きを取得します。";
export const cleanHandle = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/[^/]+\//, "").replace(/\/.*$/, "");
