"use client";
import { useActionState, useEffect, useRef } from "react";
import { Flash } from "./flash";
import type { ActionState } from "@/app/(app)/clients/[id]/settings/actions";

/**
 * Server Action を呼ぶフォーム。結果のメッセージをフォームの先頭に表示し、読み上げる。
 * 成功したら resetOnSuccess のときだけ入力を空にする。
 */
export function ActionForm({ action, children, className, resetOnSuccess = false, encType, id, label }: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  children: React.ReactNode; className?: string; resetOnSuccess?: boolean; encType?: string; id?: string; label?: string;
}) {
  const [state, run, pending] = useActionState(async (prev: ActionState & { seq?: number }, f: FormData) =>
    ({ ...(await action(prev, f)), seq: (prev.seq ?? 0) + 1 }), {} as ActionState & { seq?: number });
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={run} className={className} aria-busy={pending} encType={encType} id={id} aria-label={label}>
      {/* key を変えて、同じ内容の結果が続いても毎回フォーカスし直す */}
      {state.error && <Flash key={`e${state.seq}`} kind="error">{state.error}</Flash>}
      {state.ok && <Flash key={`o${state.seq}`} kind="ok">{state.ok}</Flash>}
      {children}
    </form>
  );
}
