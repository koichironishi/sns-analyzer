/** CSV一括予約の決まりのうち、画面でも使うもの（CSVの解析を画面に持ち込まないよう、別のファイルにする） */
export const BULK_MAX_ROWS = 100;

/** 取り込み用のCSVのひな形（Excel で開けるよう BOM 付きの UTF-8） */
export function bulkTemplate(): string {
  return "﻿配信日時,本文\r\n2026/11/01 12:00,\"新メニューのお知らせです。\r\n詳しくはプロフィールのリンクから。\"\r\n2026/11/03 18:30,週末のイベント情報です。\r\n";
}
