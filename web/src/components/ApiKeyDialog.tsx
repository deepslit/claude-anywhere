import { useState } from "react";
import { checkAuth } from "../api/client";
import { useT } from "../i18n";

interface Props {
  onSubmit: (key: string) => void;
  errorHint?: string;
}

export function ApiKeyDialog({ onSubmit, errorHint }: Props) {
  const { t } = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(errorHint ?? null);

  const submit = async () => {
    const k = value.trim();
    if (!k) {
      setError(t("auth.empty"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await checkAuth(k);
      if (!ok) {
        setError(t("auth.invalid"));
        setBusy(false);
        return;
      }
      onSubmit(k);
    } catch (e) {
      setError(t("auth.connectFail", { msg: (e as Error).message }));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#15151c] p-6 shadow-2xl">
        <h1 className="text-xl font-semibold text-white">{t("auth.title")}</h1>
        <p className="mt-1 text-sm text-white/60">
          {t("auth.help")}
        </p>
        <input
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) submit();
          }}
          placeholder={t("auth.placeholder")}
          className="mt-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-base text-white placeholder-white/50 outline-none focus:border-indigo-400"
        />
        {error && (
          <div className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="mt-5 w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {busy ? t("auth.checking") : t("auth.submit")}
        </button>
      </div>
    </div>
  );
}
