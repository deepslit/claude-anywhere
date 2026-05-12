import { useEffect, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
// Register a curated set of languages instead of pulling in all 190+
// (which would balloon the bundle by ~1 MB).
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "highlight.js/styles/github-dark.css";
import { fetchFile, type FilePayload } from "../api/client";
import { useT } from "../i18n";
import { Markdown } from "./Markdown";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

interface Props {
  apiKey: string;
  sessionId: string;
  path: string;
  onClose: () => void;
}

/**
 * Modal previewer for files inside the session's working directory.
 * - .md → react-markdown render
 * - other text → highlighted code block
 * - binary / oversized → message
 */
export function FileViewer({ apiKey, sessionId, path, onClose }: Props) {
  const { t } = useT();
  const [data, setData] = useState<FilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchFile(apiKey, sessionId, path)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled)
          setError(t("file.openFail", { msg: (e as Error).message }));
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, sessionId, path]);

  useEffect(() => {
    if (codeRef.current) {
      try {
        codeRef.current.removeAttribute("data-highlighted");
        hljs.highlightElement(codeRef.current);
      } catch {
        // ignore
      }
    }
  }, [data]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0d0d14] shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wider text-white/60">
              {t("file.title")}
            </div>
            <div className="truncate font-mono text-sm text-white">
              {data?.relative_path ?? path}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 shrink-0 items-center rounded-md border border-white/10 px-4 text-sm font-medium text-white/85 hover:bg-white/5"
          >
            {t("file.close")}
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {error && (
            <div className="px-4 py-3 text-sm text-red-300">{error}</div>
          )}
          {!error && data == null && (
            <div className="px-4 py-3 text-sm text-white/60">
              {t("file.loading")}
            </div>
          )}
          {data && data.is_binary && (
            <div className="px-4 py-3 text-sm text-white/60">
              {t("file.binary", { size: data.size })}
            </div>
          )}
          {data && !data.is_binary && data.content === "" && (
            <div className="px-4 py-3 text-sm text-white/60">
              {t("file.empty")}
            </div>
          )}
          {data &&
            !data.is_binary &&
            data.content !== null &&
            data.content !== "" &&
            (data.language === "markdown" ? (
              <div className="px-4 py-3">
                <Markdown source={data.content} />
              </div>
            ) : (
              <pre className="m-0 px-4 py-3 text-sm text-white/90">
                <code ref={codeRef} className={`language-${data.language}`}>
                  {data.content}
                </code>
              </pre>
            ))}
        </div>

        {data && (
          <div className="border-t border-white/5 px-4 py-1.5 text-[11px] text-white/55">
            {data.size} bytes · {data.language}
          </div>
        )}
      </div>
    </div>
  );
}
