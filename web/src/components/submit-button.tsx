"use client";
import { useFormStatus } from "react-dom";

/** 送信中は押せなくし、処理中であることを読み上げる */
export function SubmitButton({ children, pendingText = "処理中…", className = "btn primary", ...rest }:
  { children: React.ReactNode; pendingText?: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-disabled={pending} {...rest}>
      {pending ? <><span className="spinner" aria-hidden="true" />{pendingText}</> : children}
    </button>
  );
}
