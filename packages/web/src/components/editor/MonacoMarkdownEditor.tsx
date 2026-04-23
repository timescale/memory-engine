/**
 * Markdown source editor backed by Monaco.
 *
 * Monaco is bundled into the Vite build (not loaded from a CDN) so the UI
 * works fully offline. The Monaco web workers are imported with Vite's
 * `?worker` query so each worker lands in its own chunk and can be spawned
 * at runtime.
 */
import MonacoEditor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
// Import workers as Vite workers. Import paths come from Monaco's internal
// ESM entries.
// @ts-expect-error Vite ?worker suffix resolves at build time.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
// @ts-expect-error Vite ?worker suffix resolves at build time.
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { useEffect } from "react";

type WorkerCtor = new () => Worker;

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker;
    };
  }
}

// Hook Monaco's worker factory before the editor mounts. Only `json` has a
// language-specific worker we care about; everything else (including
// markdown) uses the default editor worker.
if (typeof window !== "undefined" && !window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker(_id, label) {
      if (label === "json") return new (JsonWorker as WorkerCtor)();
      return new (EditorWorker as WorkerCtor)();
    },
  };
  loader.config({ monaco });
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Extra height override. Defaults to a flex-fill pattern. */
  height?: string | number;
}

export function MonacoMarkdownEditor({
  value,
  onChange,
  height = "100%",
}: Props) {
  // Keep Monaco sized to its container even when the split pane resizes.
  useEffect(() => {
    const handler = () => {
      for (const editor of monaco.editor.getEditors()) editor.layout();
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return (
    <MonacoEditor
      value={value}
      onChange={(v) => onChange(v ?? "")}
      language="markdown"
      height={height}
      options={{
        minimap: { enabled: false },
        wordWrap: "on",
        fontSize: 13,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
        insertSpaces: true,
      }}
    />
  );
}
