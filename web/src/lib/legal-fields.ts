/** プライバシーポリシー・利用規約に表示する事業者情報（全体設定で入力。未入力は【要記入】と表示） */
export const LEGAL_FIELDS = {
  service_name: "サービス名",
  operator_name: "事業者名",
  operator_address: "住所",
  representative: "代表者",
  contact: "お問い合わせ窓口（メールアドレスまたはフォームURL）",
  server_location: "データを保管するサーバーの所在国（例：日本（Supabase 東京リージョン））",
  org_measures: "組織的・人的・物理的安全管理措置",
  established: "プライバシーポリシーの制定日",
  revised: "プライバシーポリシーの最終改定日（任意）",
  court: "管轄裁判所（例：東京地方裁判所）",
  terms_established: "利用規約の制定日",
  terms_revised: "利用規約の最終改定日（任意）",
} as const;
export type LegalKey = keyof typeof LEGAL_FIELDS;
export const OPTIONAL_LEGAL: LegalKey[] = ["revised", "terms_revised"];
