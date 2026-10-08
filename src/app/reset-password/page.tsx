import { Suspense } from "react";
import { PasswordResetForm } from "@/components/password-reset-form";

// useSearchParams requires a Suspense boundary so the shell can render before the query string is read.
export default function ResetPasswordPage() {
  return <Suspense fallback={null}><PasswordResetForm /></Suspense>;
}
